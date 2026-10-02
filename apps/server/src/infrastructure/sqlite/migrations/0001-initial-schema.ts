import type { Migration } from '../migrator.ts';

/**
 * RELEASED MIGRATIONS ARE IMMUTABLE — never edit this file after it has been applied anywhere (its checksum is recorded
 * and verified at startup). Fix or extend the schema with a NEW numbered migration.
 *
 * Conventions: STRICT tables (SQLite enforces column types); booleans are INTEGER 0/1 with a CHECK; timestamps are
 * ISO-8601 UTC TEXT (`2026-09-30T12:00:00.000Z`, fixed width, so string order = time order); ids are opaque TEXT issued
 * by the application (never autoincrement integers) — only `messages.rowid` is used internally, as the FTS5 row key.
 * Foreign keys are declared with an explicit ON DELETE action everywhere; see DATABASE.md for the reasoning per table.
 * Business rules (folder moves, label uniqueness, outbox transitions) stay in the application; CHECKs only protect
 * basic integrity (value sets, 0/1, exactly-one-owner).
 */
export const initialSchema: Migration = {
  version: 1,
  name: 'initial-schema',
  sql: `
-- ── Kaydet users and sessions ─────────────────────────────────────────────
CREATE TABLE users (
  id            TEXT NOT NULL PRIMARY KEY,
  identifier    TEXT NOT NULL,                    -- normalised (NFKC, trimmed, lower-cased) by the application
  password_hash TEXT NOT NULL,                    -- Argon2id PHC string; never a plaintext password
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX ux_users_identifier ON users (identifier);

CREATE TABLE sessions (
  id                 TEXT NOT NULL PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  secret_fingerprint TEXT NOT NULL,               -- SHA-256 of the cookie secret; the secret itself is never stored
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,               -- absolute end of life
  last_seen_at       TEXT NOT NULL,
  revoked_at         TEXT
) STRICT;
CREATE UNIQUE INDEX ux_sessions_fingerprint ON sessions (secret_fingerprint);            -- every authenticated request
CREATE INDEX ix_sessions_user_live ON sessions (user_id) WHERE revoked_at IS NULL;        -- revoke-all-for-user
CREATE INDEX ix_sessions_expires ON sessions (expires_at);                                -- expiry cleanup

-- ── Mail accounts and their encrypted credentials ─────────────────────────
CREATE TABLE mail_accounts (
  id                     TEXT NOT NULL PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  email                  TEXT NOT NULL,
  email_key              TEXT NOT NULL,           -- trimmed, lower-cased: one address once per user
  display_name           TEXT NOT NULL DEFAULT '',
  supports_server_labels INTEGER CHECK (supports_server_labels IN (0, 1)),   -- NULL = not known yet
  sync_status            TEXT NOT NULL DEFAULT 'idle' CHECK (sync_status IN ('idle', 'syncing', 'error')),
  last_sync_at           TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX ux_mail_accounts_user_email ON mail_accounts (user_id, email_key); -- also serves lookups by user_id

CREATE TABLE mail_account_credentials (
  account_id      TEXT NOT NULL PRIMARY KEY REFERENCES mail_accounts (id) ON DELETE CASCADE,
  encrypted_value TEXT NOT NULL,                  -- the Phase 4 envelope, verbatim (kaydet.v1.aes-256-gcm.<keyId>.…)
  key_id          TEXT,                           -- which encryption key produced it (copied from the envelope; not secret)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;
CREATE INDEX ix_credentials_key ON mail_account_credentials (key_id);                   -- key-rotation planning

-- ── Folders (local mirror of the provider's mailboxes) ────────────────────
CREATE TABLE folders (
  id                      TEXT NOT NULL PRIMARY KEY,
  account_id              TEXT NOT NULL REFERENCES mail_accounts (id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,          -- display name (Turkish for system folders)
  role                    TEXT NOT NULL CHECK (role IN ('inbox', 'sent', 'drafts', 'trash', 'junk', 'archive', 'custom')),
  provider_path           TEXT NOT NULL,          -- server folder reference (INTERNAL, never in a DTO); the tree is derived from it
  provider_delimiter      TEXT NOT NULL DEFAULT '',
  sort_order              INTEGER NOT NULL DEFAULT 100,
  is_favorite             INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),   -- local preference; sync never touches it
  provider_uid_validity   INTEGER,                -- INTERNAL sync state (prepared for the IMAP phase)
  provider_uid_next       INTEGER,
  provider_highest_modseq INTEGER,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX ux_folders_account_path ON folders (account_id, provider_path);      -- a path is one folder; folder list by account
CREATE INDEX ix_folders_account_role ON folders (account_id, role);                      -- "the Trash/Archive/Inbox of this account"

-- ── Messages ──────────────────────────────────────────────────────────────
-- One CANONICAL folder per message (folder_id). Provider identity (UID etc.) is per (folder, uid_validity, uid) and is
-- replaced when the provider moves the message; labels cover multi-membership ideas (Gmail-style) without a join table
-- for folders. See DATABASE.md "Message folder membership".
CREATE TABLE messages (
  id                    TEXT NOT NULL PRIMARY KEY,                       -- opaque API/domain id
  account_id            TEXT NOT NULL REFERENCES mail_accounts (id) ON DELETE CASCADE,
  folder_id             TEXT NOT NULL REFERENCES folders (id) ON DELETE RESTRICT,
  thread_id             TEXT NOT NULL,                                   -- domain-computed conversation id, persisted as data
  from_email            TEXT NOT NULL DEFAULT '',
  from_name             TEXT NOT NULL DEFAULT '',
  subject               TEXT NOT NULL DEFAULT '',
  preview               TEXT NOT NULL DEFAULT '',
  date_utc              TEXT NOT NULL,
  seen                  INTEGER NOT NULL DEFAULT 0 CHECK (seen IN (0, 1)),
  pinned                INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),     -- IMAP \\Flagged, "Sabitle"
  answered              INTEGER NOT NULL DEFAULT 0 CHECK (answered IN (0, 1)),
  forwarded             INTEGER NOT NULL DEFAULT 0 CHECK (forwarded IN (0, 1)),
  draft                 INTEGER NOT NULL DEFAULT 0 CHECK (draft IN (0, 1)),
  server_deleted        INTEGER NOT NULL DEFAULT 0 CHECK (server_deleted IN (0, 1)), -- IMAP \\Deleted: hidden from every list and search
  has_attachments       INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0, 1)),
  draft_id              TEXT,                                            -- the draft that edits this message (drafts.id); not a FK on purpose
  outbox_state          TEXT NOT NULL DEFAULT 'none' CHECK (outbox_state IN ('none', 'queued', 'sending', 'failed', 'sent')),
  outbox_error          TEXT,                                            -- user-safe text only, never provider output
  sender_sort_key       TEXT NOT NULL DEFAULT '',                        -- domain trLower(name or email): "sender A-Z" order without SQL casing rules
  subject_sort_key      TEXT NOT NULL DEFAULT '',                        -- domain trLower(subject)
  -- INTERNAL provider identity / sync metadata. Never selected by API-facing repository methods.
  provider_uid          INTEGER,
  provider_uid_validity INTEGER,
  provider_modseq       INTEGER,
  message_id_header     TEXT,                                            -- RFC 5322 Message-ID (also a threading input)
  in_reply_to           TEXT,
  references_raw        TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CHECK (draft_id IS NULL OR draft = 1)
) STRICT;
-- Folder list, newest first (and oldest first: SQLite scans an index backwards). Keyset pagination (date, id).
CREATE INDEX ix_messages_folder_date ON messages (account_id, folder_id, date_utc DESC, id DESC);
-- "Sabitlenenler": pinned mail of an account, newest first (partial: pinned mail is rare).
CREATE INDEX ix_messages_pinned_date ON messages (account_id, date_utc DESC, id DESC) WHERE pinned = 1;
-- Sender A-Z / subject A-Z lists of a folder.
CREATE INDEX ix_messages_folder_sender ON messages (account_id, folder_id, sender_sort_key, id);
CREATE INDEX ix_messages_folder_subject ON messages (account_id, folder_id, subject_sort_key, id);
-- Folder counters (total/unread per folder of an account): answered from this index alone (covering), never the table.
CREATE INDEX ix_messages_folder_seen ON messages (account_id, folder_id, server_deleted, seen);
-- Conversation view.
CREATE INDEX ix_messages_thread ON messages (account_id, thread_id);
-- Provider reconciliation (INTERNAL): one server message once per (folder, uidvalidity, uid); Message-ID lookups.
CREATE UNIQUE INDEX ux_messages_provider_uid ON messages (folder_id, provider_uid_validity, provider_uid) WHERE provider_uid IS NOT NULL;
CREATE INDEX ix_messages_message_id_header ON messages (account_id, message_id_header) WHERE message_id_header IS NOT NULL;

CREATE TABLE message_bodies (
  message_id     TEXT NOT NULL PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
  plain_text     TEXT,
  sanitized_html TEXT,                            -- ONLY server-sanitised HTML is ever stored (the sanitiser is a later phase)
  fetched_at     TEXT NOT NULL
) STRICT;

CREATE TABLE message_recipients (
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('to', 'cc', 'bcc')),
  position   INTEGER NOT NULL,                    -- display order within the kind
  email      TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (message_id, kind, position)
) STRICT;

-- ── Labels ────────────────────────────────────────────────────────────────
CREATE TABLE labels (
  id         TEXT NOT NULL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL,                       -- domain foldForSearch(name): "Kişisel" = "kisisel", unique per account
  tone       INTEGER NOT NULL CHECK (tone >= 0),
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX ux_labels_account_name ON labels (account_id, name_key);              -- label list by account + uniqueness

CREATE TABLE message_labels (
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  label_id   TEXT NOT NULL REFERENCES labels (id) ON DELETE CASCADE,                      -- deleting a label removes its associations
  PRIMARY KEY (message_id, label_id)
) STRICT;
CREATE INDEX ix_message_labels_label ON message_labels (label_id);                       -- "messages with this label"

-- ── Drafts, attachments metadata, outbox ──────────────────────────────────
-- Draft ids are chosen by the CLIENT, so they are only unique per user: the key is (user_id, id).
CREATE TABLE drafts (
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  id             TEXT NOT NULL,
  account_id     TEXT NOT NULL REFERENCES mail_accounts (id) ON DELETE CASCADE,
  subject        TEXT NOT NULL DEFAULT '',
  body_text      TEXT NOT NULL DEFAULT '',
  body_html      TEXT,                            -- user-authored outgoing HTML from the editor (not received mail)
  source_message_id TEXT,                         -- the message being answered (opaque; validated by the application)
  source_mode    TEXT CHECK (source_mode IN ('reply', 'replyAll', 'forward')),
  message_id     TEXT REFERENCES messages (id) ON DELETE SET NULL,   -- the Drafts-folder message; deleting it never deletes the draft
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  CHECK ((source_message_id IS NULL) = (source_mode IS NULL))
) STRICT;
CREATE INDEX ix_drafts_account_updated ON drafts (account_id, updated_at DESC);

CREATE TABLE draft_recipients (
  user_id  TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('to', 'cc', 'bcc')),
  position INTEGER NOT NULL,
  email    TEXT NOT NULL,
  name     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, draft_id, kind, position),
  FOREIGN KEY (user_id, draft_id) REFERENCES drafts (user_id, id) ON DELETE CASCADE
) STRICT;

-- Attachment METADATA only (bytes belong to blob storage, a later phase). Owned by exactly one message or one draft.
CREATE TABLE attachments (
  id               TEXT NOT NULL PRIMARY KEY,
  message_id       TEXT REFERENCES messages (id) ON DELETE CASCADE,
  draft_user_id    TEXT,
  draft_id         TEXT,
  file_name        TEXT NOT NULL,
  mime_type        TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL CHECK (size_bytes >= 0),
  is_inline        INTEGER NOT NULL DEFAULT 0 CHECK (is_inline IN (0, 1)),
  content_id       TEXT,                          -- cid: reference of an inline part
  provider_part_id TEXT,                          -- INTERNAL: MIME part path at the provider (never in a DTO)
  created_at       TEXT NOT NULL,
  FOREIGN KEY (draft_user_id, draft_id) REFERENCES drafts (user_id, id) ON DELETE CASCADE,
  CHECK ((message_id IS NOT NULL) + (draft_id IS NOT NULL) = 1),
  CHECK ((draft_id IS NULL) = (draft_user_id IS NULL))
) STRICT;
CREATE INDEX ix_attachments_message ON attachments (message_id) WHERE message_id IS NOT NULL;   -- a message's attachments
CREATE INDEX ix_attachments_draft ON attachments (draft_user_id, draft_id) WHERE draft_id IS NOT NULL;

-- A send operation. Its own id (draft id ≠ outbox id ≠ message id). Storage only: transitions are owned by the application
-- and the (future) worker; the CHECK only limits the value set. 'none' exists in the API for messages but is never a row.
CREATE TABLE outbox (
  id                 TEXT NOT NULL PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id         TEXT NOT NULL REFERENCES mail_accounts (id) ON DELETE CASCADE,
  draft_user_id      TEXT NOT NULL,
  draft_id           TEXT NOT NULL,
  message_id         TEXT REFERENCES messages (id) ON DELETE SET NULL,
  state              TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'failed', 'sent')),
  cancellable_until  TEXT,
  error              TEXT,                        -- user-safe failure text; raw SMTP output is never stored
  attempt_count      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at    TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK (draft_user_id = user_id),
  FOREIGN KEY (draft_user_id, draft_id) REFERENCES drafts (user_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX ix_outbox_account_state ON outbox (account_id, state, updated_at);          -- worker: due/queued items of an account
CREATE INDEX ix_outbox_draft ON outbox (user_id, draft_id, created_at);                  -- "latest send of this draft"

-- ── Signatures and quick templates ────────────────────────────────────────
CREATE TABLE signatures (
  account_id TEXT NOT NULL REFERENCES mail_accounts (id) ON DELETE CASCADE,
  id         TEXT NOT NULL,                       -- chosen by the client, unique per account
  name       TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, id)
) STRICT;
CREATE UNIQUE INDEX ux_signatures_default ON signatures (account_id) WHERE is_default = 1;  -- at most one default per account

CREATE TABLE templates (
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  id          TEXT NOT NULL,                      -- chosen by the client, unique per user
  title       TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  is_built_in INTEGER NOT NULL DEFAULT 0 CHECK (is_built_in IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
) STRICT;   -- list order = insertion order (rowid), like the mobile template list

-- ── Search index (mobile parity: FTS5, rowid = messages.rowid, folded text) ─
-- content = domain foldForSearch(subject, sender name, sender e-mail, preview, plain body), written by the repository in
-- the same transaction as the message; the query is folded and tokenised by the domain, so "sahan" finds "Şahan".
CREATE VIRTUAL TABLE messages_fts USING fts5 (content, tokenize = 'unicode61 remove_diacritics 2');
`,
};

# Kaydet server — database (SQLite)

Phase 5 replaced the in-memory persistence with SQLite behind the **unchanged repository ports**. Use cases, HTTP and the
domain know nothing about SQLite; only `src/infrastructure/sqlite/` does (enforced by ESLint, `scripts/check-boundaries.mjs` and
`security-guards.test.ts`). Read with `ARCHITECTURE.md` (layers) and `SECURITY.md` (credentials, sessions).

## 1. Architecture

```
HTTP  ──▶  Application (use cases, services)  ──▶  Repository ports  ──▶  infrastructure/sqlite  ──▶  SQLite file (WAL)
                        │                            UnitOfWork port           SqliteDatabase (the ONLY driver user)
                        └── transactions.run(…)  ─────────────────────────▶  BEGIN IMMEDIATE … COMMIT / ROLLBACK
```

- **Driver: `node:sqlite`** (built into Node ≥ 24.7, bundled SQLite 3.5x with FTS5). *Why:* no native addon to compile or patch,
  no new dependency to trust — the same reasoning as Argon2 in Phase 4 — and it gives prepared statements, transactions, WAL, foreign
  keys and FTS5, which is everything required. *Why not `better-sqlite3`:* an extra native dependency for no capability we need.
  *No ORM:* explicit SQL keeps the mapping between domain rules and storage visible and reviewable. **No dependency was added.**
- **Explicit ports, generic adapters:** `SqliteUserRepository`, `SqliteSessionRepository`, `SqliteAccountRepository`,
  `SqliteCredentialRepository`, `SqliteFolderRepository`, `SqliteMessageRepository`, `SqliteMailStore` (write side),
  `SqliteDraftRepository`, `SqliteOutboxRepository`, `SqliteLabelRepository`, `SqliteSignatureRepository`,
  `SqliteTemplateRepository`, `SqliteUnitOfWork`. The in-memory adapters remain (fast application-level tests; the default when no
  database path is configured, i.e. `NODE_ENV=test`).
- **One connection.** `node:sqlite` is synchronous; `SqliteDatabase` gives it an async, transaction-safe face (§8). Application code
  never receives the handle; HTTP receives nothing database-shaped.

## 2. Location

`DATABASE_PATH` (validated centrally in `config/`):

| Environment | Rule |
|---|---|
| production | **required**, must be **absolute**, never `:memory:`; the server does **not** create the directory and refuses to start if it is missing |
| development | default `./data/kaydet.db` (under the working directory; directory created automatically — explicit, documented, git-ignored) |
| test | none → in-memory repositories (`DATABASE_PATH` may still point a test at a file) |

`.gitignore` excludes `*.db`, `*.db-wal`, `*.db-shm`, `*.db-journal`, `*.sqlite*` and `data/`. The server also refuses to open a
SQLite file that is not a Kaydet database (§4 `application_id`) and never drops, truncates or recreates a database.

## 3. Connection lifecycle

```
load config → open file → PRAGMAs (set AND read back) → identity check → migrations → repositories → services → listen
                                       any failure ⇒ close the connection, exit non-zero, HTTP is never started
shutdown:  stop accepting → drain in-flight requests → close event bus → close SQLite (WAL checkpointed) → exit
```

`startServer` opens persistence *before* building the app; a failed `listen` (port taken) also closes the database. After a clean
shutdown the `-wal`/`-shm` files are gone (tested). The connection is closed last, after HTTP has drained.

## 4. PRAGMAs (verified programmatically at every open, not assumed)

| PRAGMA | Value | Why |
|---|---|---|
| `foreign_keys` | `ON` | SQLite ignores foreign keys unless asked, per connection. Read back; startup fails otherwise. |
| `journal_mode` | `WAL` (files) | readers do not block the writer; crash-safe. Read back must say `wal`. (`:memory:` has no WAL.) |
| `synchronous` | `FULL` | users, sessions and encrypted credentials are **authoritative**, not a rebuildable cache: a commit must survive power loss. WAL + `NORMAL` could lose the last commits. Cost: one fsync per commit (measured below). |
| `busy_timeout` | `DATABASE_BUSY_TIMEOUT_MS` (5000) | how long to wait for *another process's* lock. Fails with `service_unavailable` (retryable) instead of hanging or a raw error. |
| `journal_size_limit` | 64 MiB | bounds the WAL file after checkpoints. |
| `trusted_schema` | `OFF` | hardening: no untrusted SQL functions in schema objects. |
| `application_id` | `0x4B415944` ("KAYD") | set on a fresh empty file; a non-empty file without it is refused, **before any write** (a foreign file is left byte-for-byte unchanged — tested). |

Tests read every value back (`database.test.ts`); WAL is proven by the `-wal` file appearing, persisting in the file header, and
disappearing after the final checkpoint.

## 5. Migrations

`src/infrastructure/sqlite/migrations/NNNN-name.ts` export `{ version, name, sql }`; `migrations/index.ts` lists them in order.
`schema_migrations(version, name, checksum, applied_at)` records what ran. The runner (`migrator.ts`):

- runs pending migrations in order, **each in one transaction together with its bookkeeping row** (fully applied or not at all);
- is **idempotent** (a second start finds nothing to do);
- verifies each applied migration's **SHA-256 checksum** — editing a released migration stops startup (*released migrations are immutable*);
- refuses a database **newer than the code**, a gap in versions, or a non-sequential list;
- on failure throws `MigrationError` (version + name only — no data, no credentials) and the caller exits **before serving**;
- never uses `CREATE TABLE IF NOT EXISTS` for schema (the single table that precedes all migrations, `schema_migrations`, is created
  explicitly if absent).

**Current versions:** `1 — initial-schema`. **Adding one:** create `0002-what-it-does.ts` exporting the next `Migration`, append it to
`migrations/index.ts`, never touch earlier files, add a test that repositories still work on the result. A destructive change (drop a
column/table) is a migration of its own, reviewed as such — nothing destructive ever runs implicitly. Rolling *back* is a new forward
migration (or a restore, §14). Until `0001` has been applied anywhere real, the schema may still be corrected in place; after that it is frozen.

## 6. Schema overview

Conventions: `STRICT` tables; booleans `INTEGER 0/1` with CHECK; timestamps ISO-8601 UTC text (§11); ids are opaque application-issued
`TEXT` (never autoincrement integers; `messages.rowid` exists internally only as the FTS row key).

```
users ─┬─< sessions
       ├─< mail_accounts ─┬── mail_account_credentials (1:1, ciphertext)
       │                  ├─< folders ─< messages ─┬─< message_recipients
       │                  │                         ├── message_bodies (1:1)
       │                  │                         ├─< message_labels >─ labels
       │                  │                         └─< attachments (metadata)
       │                  ├─< labels, signatures
       │                  ├─< drafts ─┬─< draft_recipients
       │                  │           └─< attachments (metadata, owned by the draft)
       │                  └─< outbox (── draft, ── message once sent)
       ├─< drafts, outbox, templates (per user)
messages_fts  (FTS5, rowid = messages.rowid)        schema_migrations
```

| Table | Purpose | Key | Foreign keys (on delete) | Unique | Important indexes | Lifecycle | Sensitivity |
|---|---|---|---|---|---|---|---|
| `users` | Kaydet users (Phase 4 model) | `id` | – | `identifier` (normalised) | `ux_users_identifier` (login lookup) | created by user administration; never deleted by the app | **hash** (Argon2id); never plaintext |
| `sessions` | server-side sessions | `id` | user → **CASCADE** | `secret_fingerprint` | `ux_sessions_fingerprint` (every request), `ix_sessions_user_live` (revoke-all, partial), `ix_sessions_expires` (cleanup) | created at login; revoked by logout/revoke-all; expired rows are dead, not deleted (cleanup job is future work) | **fingerprint only**; the cookie secret is never stored |
| `mail_accounts` | one mailbox of one user (metadata + sync status) | `id` | user → **RESTRICT** | `(user_id, email_key)` | that unique index (per-user list, duplicate check) | created/updated by the user; **deleting an account deletes its whole local mirror** (§7) | e-mail address (personal data), no secrets |
| `mail_account_credentials` | the encrypted IMAP/SMTP credential | `account_id` | account → **CASCADE** | – | `ix_credentials_key` (rotation: "records still under key X") | replaced in one step on update; gone with the account | **ciphertext only** — SQLite never sees plaintext and never decrypts |
| `folders` | local mirror of provider mailboxes | `id` | account → CASCADE | `(account_id, provider_path)` | that index (folder list), `ix_folders_account_role` ("the Trash of this account") | written by sync; `removeFolder` deletes its messages explicitly | names; **`provider_path`/uid state are internal** |
| `messages` | mail as the API shows it + internal provider identity | `id` | account → CASCADE; folder → **RESTRICT** | `(folder_id, provider_uid_validity, provider_uid)` when a UID exists | `ix_messages_folder_date`, `_pinned_date` (partial), `_folder_sender`, `_folder_subject`, `_folder_seen` (covering counters), `_thread`, `ux_messages_provider_uid`, `_message_id_header` | upserted by sync; hidden (not deleted) when `\Deleted`; removed when the provider removes it | personal mail metadata; **provider columns never selected by API-facing repositories** |
| `message_bodies` | plain text + **sanitised** HTML | `message_id` | message → CASCADE | – | PK | with the message | mail content (no extra encryption, §13) |
| `message_recipients` | to/cc/bcc, ordered | `(message_id, kind, position)` | message → CASCADE | – | PK | replaced as a set with each message write | addresses (personal data) |
| `labels` | per-account labels | `id` | account → CASCADE | `(account_id, name_key)` | that index | user-managed | – |
| `message_labels` | message ↔ label | `(message_id, label_id)` | message → CASCADE; label → **CASCADE** | (the PK) | `ix_message_labels_label` | deleting a label removes its associations; no dangling row can exist | – |
| `drafts` | editor state, keyed **per user** (client-generated id) | `(user_id, id)` | user → CASCADE; account → CASCADE; `message_id` → messages **SET NULL** | – | `ix_drafts_account_updated` | autosaved; deleting a draft never deletes a message | draft content |
| `draft_recipients` | ordered draft recipients | `(user_id, draft_id, kind, position)` | draft → CASCADE | – | PK | with the draft | addresses |
| `attachments` | attachment **metadata** (no bytes) of a message **or** a draft | `id` | message → CASCADE; draft → CASCADE | – | `ix_attachments_message`, `ix_attachments_draft` (partial) | with its owner; exactly one owner (CHECK) | file names; `provider_part_id` internal |
| `outbox` | send operations (own id ≠ draft id ≠ message id) | `id` | user, account → CASCADE; draft → **CASCADE**; message → SET NULL | – | `ix_outbox_account_state` (worker), `ix_outbox_draft` (latest send of a draft) | created by send; removed by cancel; rows with a draft go with it | user-safe error text only |
| `signatures` | per-account signatures | `(account_id, id)` | account → CASCADE | one default per account (partial unique index) | that index | user-managed | – |
| `templates` | quick replies of a user | `(user_id, id)` | user → CASCADE | – | PK (list order = `rowid`) | user-managed | – |
| `messages_fts` | search index (FTS5) | `rowid` = `messages.rowid` | none (virtual) | – | – | written by `SqliteMailStore` in the same transaction as the message | folded copy of subject/sender/preview/plain body |
| `schema_migrations` | applied migrations | `version` | – | – | – | migrator only | – |

Not created (no speculative tables): contacts, translations, pending-operation queue (Phase 7 owns the durable worker; `outbox`
already stores what the contract defines), per-message attachments blobs.

## 7. Foreign keys and destructive cascades (deliberate)

| Relation | Action | Reason |
|---|---|---|
| users → sessions, drafts, outbox, templates | CASCADE | meaningless without their user |
| users → mail_accounts | **RESTRICT** | a user with mailboxes cannot vanish by accident; accounts are deleted explicitly first |
| mail_accounts → credentials, folders, messages, labels, signatures, drafts, outbox | CASCADE | deleting a Kaydet mail account **must** delete its local mirror and its encrypted credential (`deleteAccount`). Provider mail is untouched. |
| folders → messages | **RESTRICT** | mail must never disappear because a folder row was removed; `SqliteMailStore.removeFolder` deletes the messages explicitly, in one transaction, when the provider folder is gone. (Because of this, `SqliteAccountRepository.remove` deletes messages *before* the account.) |
| messages → recipients, body, attachments, message_labels | CASCADE | dependent parts |
| labels → message_labels | CASCADE | "deleting a label cannot leave invalid associations" |
| drafts → draft_recipients, attachments, outbox | CASCADE | an outbox row without its draft has no meaning; a failed send is discarded with its draft (queued/sending/sent drafts cannot be deleted — application rule) |
| drafts.message_id, outbox.message_id → messages | **SET NULL** | deleting a message never deletes a draft or a send record |

The **folder tree** has no `parent_id`: it is *derived* by the domain's `buildFolderTree` from `provider_path` + `provider_delimiter` + role
(exactly the mobile rule: system folders are roots; a custom folder whose parent is missing becomes a root). A stored parent could drift from
the path; a cycle is unrepresentable. Business rules (invalid folder moves, system-folder protection) stay in the application, not in triggers.

## 8. Transaction boundaries

The **use case** owns the boundary; repositories do not open transactions of their own where that would prevent composition.

```
use case ──▶ transactions.run(async () => { repoA…; repoB…; })    (UnitOfWork port)
                     └─▶ SqliteDatabase.transaction: BEGIN IMMEDIATE (exclusive, in-process lock) … COMMIT / ROLLBACK
```

- Inside `run`, repository calls are recognised through `AsyncLocalStorage` and execute inside the transaction; **every other statement
  waits** until it ends, so an unrelated request can never be swallowed by (or rolled back with) someone else's transaction on the single
  connection. A nested `run` joins the outer one. **Keep transactions short** — no hashing or network inside; they stall other database work.
- Repository methods that write several rows (`upsertMessage`, `DraftRepository.save`, `SqliteAccountRepository.remove`, folder removal)
  wrap themselves in a joining transaction, so they are atomic alone and compose inside a larger one.
- **Events are published after the commit**, never inside.

Implemented boundaries: **login** (revoke presented session + create new) · **create account** (account + encrypted credential; duplicate check
inside) · **update account** (metadata + credential replace, read-merge-replace) · **delete account** (account mirror + credential) ·
**put draft** ("already sent?" check + write) · **send draft** (check + outbox insert: two concurrent sends cannot both succeed) ·
**cancel send** (still-cancellable check + removal) · **delete draft** · **default signature** (clear others + set) · **credential update /
re-encryption** · plus every multi-row repository write above. Sync batches (Phase 6) wrap many `MailStoreWriter` calls in one `run`.
Message *actions* (`applyActions`) go through the mail port (provider); their local state changes belong to the sync phase.

## 9. Concurrency and errors

One process, one connection: request-level concurrency is handled by the transaction gate above (tested with concurrent sends, concurrent
account creation, concurrent default-signature writes, and reads during writes). Across **processes** (a second server, a backup tool, a
shell): WAL lets readers proceed; a writer waits up to `busy_timeout`, then `SQLITE_BUSY/LOCKED` becomes `AppError('service_unavailable')` with
`retryAfterSeconds: 1` — never swallowed, never raw. Every other driver error becomes a generic `DatabaseError` (→ `internal_error`, HTTP 500);
the SQLite text is only in the server log's `cause`. Uniqueness violations the application expects (user identifier, account e-mail, label
name) are translated by the owning repository (`false` / `account_exists` / `label_exists`). Run **one server instance per database file**.

## 10. Indexes (each tied to a query; verified with `EXPLAIN QUERY PLAN`)

| Index | Query it serves |
|---|---|
| `ux_users_identifier` | sign-in lookup |
| `ux_sessions_fingerprint` | session resolution on every authenticated request |
| `ix_sessions_user_live` (partial) / `ix_sessions_expires` | revoke-all-for-user / expiry cleanup |
| `ux_mail_accounts_user_email` | a user's accounts; duplicate-address guard |
| `ix_credentials_key` | key rotation: which records use which key |
| `ux_folders_account_path`, `ix_folders_account_role` | folder list; role lookup |
| `ix_messages_folder_date (account, folder, date DESC, id DESC)` | folder list newest/oldest first + keyset cursor; filters (unread/attachments/label) ride on this walk |
| `ix_messages_pinned_date` (partial `pinned=1`) | the "Sabitlenenler" view |
| `ix_messages_folder_sender` / `_subject` | sender A–Z / subject A–Z lists |
| `ix_messages_folder_seen (account, folder, server_deleted, seen)` | folder counters answered from the index alone (covering) |
| `ix_messages_thread` | conversation lookup |
| `ux_messages_provider_uid` (partial), `ix_messages_message_id_header` | provider reconciliation (Phase 6) |
| `ux_labels_account_name`, `ix_message_labels_label` | label list/uniqueness; messages of a label |
| `ix_drafts_account_updated`, `ix_outbox_account_state`, `ix_outbox_draft` | drafts by account; worker picks up due items; latest send of a draft |
| `ix_attachments_message`, `ix_attachments_draft` | a message's / draft's attachment metadata |

Measured with 6,000 messages (5 recipients each, attachments on 40 %, labels on a third), 300 folders, 200 labels, on a development machine:
loading 6,000 messages with all parts and search rows in transactions of 500: ~1.9 s; first page (30 rows) ≈ 4–8 ms; a page after 3,000 rows
≈ 4 ms (keyset — the same cost as the first); pinned view ≈ 1 ms; label filter ≈ 13 ms; folder tree with counters for 300 folders ≈ 3 ms; one
full message ≈ 1 ms; a two-token search returning the newest 30 of ~6,000 matches ≈ 16 ms. The plans confirm the intended indexes and no temp
sorts for list queries (`performance.test.ts`). These are observations, not benchmarks or guarantees.

## 11. Timestamps, ids

Timestamps are **ISO-8601 UTC text with milliseconds** (`2026-09-30T12:00:00.000Z`), the API's own format: fixed width, so string order = time
order (indexes and cursors depend on it), independent of SQLite date functions and the machine time zone. Inputs with offsets are normalised to `Z`;
an invalid date is refused. A stored value that is not in this shape is a corruption error. Ids are opaque application-issued strings (UUIDs
for server-issued ids; client-generated ids for drafts/signatures/templates, scoped per user/account by their keys) and stable across restarts.

## 12. Pagination

The application owns the cursor (`application/pagination.ts`, bound to account + scope + filter + sort). SQLite adapters use a **keyset**
`(sort value, id)` — `WHERE (date_utc, id) < (?, ?) ORDER BY date_utc DESC, id DESC LIMIT n+1` — never `OFFSET`, so a list is stable while mail arrives
or disappears (tested: no duplicate, no skipped row) and page cost does not grow with depth. The position is untrusted input from a browser cursor
and is validated strictly (`invalid_cursor`). A/Z sort keys are stored **truncated to 200 characters** so any cursor fits the contract's limit.
No row offset, rowid, UID, UIDVALIDITY or MODSEQ is ever in a cursor. (A cursor is opaque, not secret: it is an unsigned keyset — see ARCHITECTURE.)

## 13. Credentials and the encryption boundary

`mail_account_credentials.encrypted_value` holds the **Phase 4 envelope verbatim** (`kaydet.v1.aes-256-gcm.<keyId>.<iv>.<ciphertext>.<tag>`);
`key_id` copies the envelope's key id (non-secret) for rotation queries. `SqliteCredentialRepository` never decrypts and has no access to keys —
it stores and returns an opaque string. Only the credential vault (through `CryptoPort`) can read a credential, and only inside
`MailCredentialResolver.withCredentialForMailAdapter`. Tests scan the raw database file **and the WAL** for credential plaintext, passwords, session
secrets and CSRF tokens (none present).

**No full-database encryption and no encryption of mail content:** the threat addressed is credential theft from a copied database (done by Phase 4
envelope encryption). Encrypting mail bodies would need per-row keys and would defeat FTS; there is no requirement for it, and encrypting arbitrary
content without a concrete requirement adds cost and false comfort. Deployments that need encryption at rest should use disk/volume encryption
(or SQLCipher in a future phase) — see §14.

## 14. Backup, restore, safety

- **Files:** `kaydet.db` plus, while running, `kaydet.db-wal` and `kaydet.db-shm`. Copying only `kaydet.db` of a running server can miss committed
  data that still lives in the WAL and can yield a torn copy. **Do not `cp` a live database.**
- **Backup:** stop the server (a clean shutdown checkpoints the WAL and removes the sidecar files — then copying `kaydet.db` is safe), **or** use SQLite's
  online backup (`sqlite3 kaydet.db ".backup 'copy.db'"`, or `VACUUM INTO`), which yields a consistent snapshot of a running database. Back up the
  **encryption keys separately** (`CREDENTIAL_ENCRYPTION_KEYS`, in a secret store): a restored database is useless for credentials without them, and keys must
  not be stored next to the backups.
- **Restore:** stop the server, replace `kaydet.db`, **delete stale `-wal`/`-shm` files**, start. Migrations run forward automatically. Restoring a database taken with a *newer*
  schema into an *older* server is refused (§5).
- **Encryption at rest:** not provided by SQLite here; use an encrypted volume/disk. Backups contain personal mail metadata and bodies in plaintext — protect them like the database.
- **Persistence location:** persistent storage (not a container's ephemeral layer); local disks, not network filesystems (SQLite locking is unreliable there).
- **Nothing here is backup automation.** No backup service exists in this phase, and "it is a local file" is not a backup.
- `PRAGMA integrity_check` should be part of any restore verification.

## 15. Semantics decisions

- **Message ↔ folder membership:** one **canonical** folder per message (`messages.folder_id`). The API contract has a single `folderId` per message, IMAP identity
  (UID) is per mailbox, and moves are UID-changing operations that sync reconciles by replacing the message's provider identity (its API id is kept).
  Providers with multi-folder semantics (Gmail-style) are handled through **labels**, which already exist. A join table can be added by a later migration if a
  provider needs it; nothing here prevents that (`provider_uid*` sits on the message, `ux_messages_provider_uid` is per folder).
- **Provider identity vs API identity:** `messages.id` (opaque, stable) is independent of `provider_uid`, `provider_uid_validity`, `provider_modseq`, `message_id_header`,
  `in_reply_to`, `references_raw`, folders' `provider_*` columns and `attachments.provider_part_id`. Read repositories select **explicit API columns only**; the values
  are reachable solely through `MailStoreWriter.providerRefOf…` (a port the application barrel does not export). Tests store a message with provider identity and assert
  none of it appears in any DTO, list, search or error.
- **Bodies:** `plain_text` and **sanitised** HTML are separate rows; only sanitised HTML is accepted (`sanitized: true` is a literal in the contract type). The sanitiser
  itself is **not** in this phase. No raw provider HTML is stored; if a raw representation is ever needed it must be a separate, never-browser-exposed column, designed with the sanitiser.
- **Threading:** `thread_id` is persisted as data (the domain computes it); `message_id_header`, `in_reply_to`, `references_raw` are stored as its inputs. No conversation API.
- **Soft vs hard delete:** *hard* delete for what is permanently deleted (`deletePermanently`, drafts, labels, accounts). Trash is a **domain operation** — a message in the Trash *folder*, not a
  flag. The one soft state is `server_deleted` (IMAP `\Deleted`): stored but invisible everywhere, exactly like mobile, because sync must still see it. No blanket soft-delete.
- **Attachments:** metadata only (no BLOB column exists); bytes are a later phase's blob storage.
- **Search (FTS5) — implemented, because mobile requires it:** `messages_fts(content)`, tokenizer `unicode61 remove_diacritics 2`, `rowid = messages.rowid`; `content` =
  domain `foldForSearch(subject + sender name + sender e-mail + preview + plain body)` written by `SqliteMailStore` in the **same transaction** as the message (insert/update replace the row,
  delete/folder-remove/account-wipe remove it — tested: no orphan, no stale term, exactly one row per message). The query is folded and tokenised by the **domain**
  (`tokenizeSearchQuery`) into quoted prefix tokens (`"tok"*`), so user input cannot become FTS syntax; results are ordered newest-first before the limit (mobile). Folder/role,
  trash-exclusion, attachment, date-range and `\Deleted` rules are the domain's filter semantics. **Nothing Turkish is normalised in SQL.** *Deferred (Phase 11):* attachment-file search,
  contact search, highlighting/snippets, relevance ranking, index rebuild tooling, search UI behaviour.
- **Outbox state machine** (the database only limits the value set to `queued | sending | failed | sent`; `none` exists in the API for messages but is never a row): `queued → sending → sent`,
  `sending → failed`, `failed → queued` (retry: `attempt_count`+1, `next_attempt_at` from the worker's back-off), `queued → (row removed)` on cancel within `cancellableUntil`; `sent` and a
  permanently `failed` item are terminal. Who may perform a transition, and when, is the application's/worker's rule (Phase 7) — no triggers. Retry metadata (`attempt_count`, `next_attempt_at`) is internal (not in
  the DTO) and read/written through `OutboxRepository.retryState/setRetryState`. Failure text is the safe `error` string; raw SMTP output is never stored.

## 16. Deferred (mail synchronisation and beyond)

No IMAP, SMTP, provider login, folder or message synchronisation, UID reconciliation, MODSEQ handling, polling, durable outbox worker, SSE, attachment blob storage, HTML sanitiser or search UI exists.
Ready for Phase 6: `MailStoreWriter` (folders/messages with provider identity, atomic batches), `MailCredentialResolver` (decrypt for the adapter), the outbox storage, labels-by-name resolution,
the `folders.provider_uid_*` and `messages.provider_*` columns, and the unit of work. Phase 6 must ensure labels exist before storing messages that carry them, and must sanitise HTML before `upsertMessage`.

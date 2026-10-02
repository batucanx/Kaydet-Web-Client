import type { Migration } from '../migrator.ts';

export const syncEngineSchema: Migration = {
  version: 2,
  name: 'sync-engine',
  sql: `
-- ── Mailbox Synchronization Checkpoints & Leases ──────────────────────────
CREATE TABLE mailbox_sync_state (
  account_id          TEXT NOT NULL REFERENCES mail_accounts (id) ON DELETE CASCADE,
  folder_id           TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
  mailbox_path        TEXT NOT NULL,
  uid_validity        INTEGER,
  uid_next            INTEGER,
  highest_modseq      INTEGER,
  last_synced_uid     INTEGER,
  total_count         INTEGER NOT NULL DEFAULT 0,
  has_more_on_server  INTEGER NOT NULL DEFAULT 0 CHECK (has_more_on_server IN (0, 1)),
  sync_status         TEXT NOT NULL DEFAULT 'idle' CHECK (sync_status IN ('idle', 'syncing', 'failed')),
  last_sync_at        TEXT,
  last_attempt_at     TEXT,
  last_error          TEXT,
  lease_token         TEXT,
  lease_expires_at    TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (account_id, folder_id)
) STRICT;
CREATE INDEX ix_mailbox_sync_state_account ON mailbox_sync_state (account_id);

-- ── Durable Outbox Worker Leases & Multi-worker Index ──────────────────────
ALTER TABLE outbox ADD COLUMN lease_token TEXT;
ALTER TABLE outbox ADD COLUMN lease_expires_at TEXT;
CREATE INDEX ix_outbox_claimable ON outbox (state, cancellable_until, next_attempt_at, lease_expires_at);
`.trim(),
};

import type { AuthorizedAccount } from '../../application/context/authorized-account.ts';
import type { Clock } from '../../application/ports/clock/clock.ts';
import type { MailboxSyncState, MailboxSyncStatus, SyncStateRepository } from '../../application/ports/mail/sync-state.ts';
import { bit, fromIsoOrNull, int, intOrNull, text, textOrNull, toIso } from './common.ts';
import type { SqliteDatabase } from './database.ts';

export class SqliteSyncStateRepository implements SyncStateRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  async getState(account: AuthorizedAccount, folderId: string): Promise<MailboxSyncState | null> {
    const r = await this.db.get(
      `SELECT account_id, folder_id, mailbox_path, uid_validity, uid_next, highest_modseq,
              last_synced_uid, total_count, has_more_on_server, sync_status,
              last_sync_at, last_attempt_at, last_error, lease_token, lease_expires_at
       FROM mailbox_sync_state WHERE account_id = ? AND folder_id = ?`,
      [account.id, folderId],
    );
    if (r === undefined) return null;

    return {
      accountId: text(r['account_id']),
      folderId: text(r['folder_id']),
      mailboxPath: text(r['mailbox_path']),
      uidValidity: intOrNull(r['uid_validity']),
      uidNext: intOrNull(r['uid_next']),
      highestModSeq: intOrNull(r['highest_modseq']),
      lastSyncedUid: intOrNull(r['last_synced_uid']),
      totalCount: int(r['total_count']),
      hasMoreOnServer: int(r['has_more_on_server']) === 1,
      syncStatus: text(r['sync_status']) as MailboxSyncStatus,
      lastSyncAt: fromIsoOrNull(r['last_sync_at']),
      lastAttemptAt: fromIsoOrNull(r['last_attempt_at']),
      lastError: textOrNull(r['last_error']),
      leaseToken: textOrNull(r['lease_token']),
      leaseExpiresAt: fromIsoOrNull(r['lease_expires_at']),
    };
  }

  async saveState(account: AuthorizedAccount, state: MailboxSyncState): Promise<void> {
    const now = toIso(this.clock.now());
    await this.db.run(
      `INSERT INTO mailbox_sync_state (
        account_id, folder_id, mailbox_path, uid_validity, uid_next, highest_modseq,
        last_synced_uid, total_count, has_more_on_server, sync_status,
        last_sync_at, last_attempt_at, last_error, lease_token, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, folder_id) DO UPDATE SET
        mailbox_path = excluded.mailbox_path,
        uid_validity = excluded.uid_validity,
        uid_next = excluded.uid_next,
        highest_modseq = excluded.highest_modseq,
        last_synced_uid = excluded.last_synced_uid,
        total_count = excluded.total_count,
        has_more_on_server = excluded.has_more_on_server,
        sync_status = excluded.sync_status,
        last_sync_at = excluded.last_sync_at,
        last_attempt_at = excluded.last_attempt_at,
        last_error = excluded.last_error,
        lease_token = excluded.lease_token,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at
      WHERE mailbox_sync_state.account_id = excluded.account_id`,
      [
        account.id,
        state.folderId,
        state.mailboxPath,
        state.uidValidity,
        state.uidNext,
        state.highestModSeq,
        state.lastSyncedUid,
        state.totalCount,
        bit(state.hasMoreOnServer),
        state.syncStatus,
        state.lastSyncAt ? toIso(state.lastSyncAt) : null,
        state.lastAttemptAt ? toIso(state.lastAttemptAt) : null,
        state.lastError,
        state.leaseToken,
        state.leaseExpiresAt ? toIso(state.leaseExpiresAt) : null,
        now,
        now,
      ],
    );
  }

  async acquireLease(
    account: AuthorizedAccount,
    folderId: string,
    mailboxPath: string,
    leaseToken: string,
    durationMs: number,
  ): Promise<boolean> {
    const now = this.clock.now();
    const nowIso = toIso(now);
    const expiresIso = toIso(new Date(now.getTime() + durationMs));

    const { changes } = await this.db.run(
      `INSERT INTO mailbox_sync_state (
        account_id, folder_id, mailbox_path, sync_status, lease_token, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'syncing', ?, ?, ?, ?)
      ON CONFLICT(account_id, folder_id) DO UPDATE SET
        sync_status = 'syncing',
        lease_token = excluded.lease_token,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at
      WHERE mailbox_sync_state.account_id = excluded.account_id
        AND (
          mailbox_sync_state.lease_expires_at IS NULL
          OR mailbox_sync_state.lease_expires_at <= ?
          OR mailbox_sync_state.lease_token = ?
        )`,
      [
        account.id,
        folderId,
        mailboxPath,
        leaseToken,
        expiresIso,
        nowIso,
        nowIso,
        nowIso,
        leaseToken,
      ],
    );

    return changes > 0;
  }

  async releaseLease(account: AuthorizedAccount, folderId: string, leaseToken: string): Promise<void> {
    const nowIso = toIso(this.clock.now());
    await this.db.run(
      `UPDATE mailbox_sync_state
       SET sync_status = CASE WHEN sync_status = 'syncing' THEN 'idle' ELSE sync_status END,
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = ?
       WHERE account_id = ? AND folder_id = ? AND lease_token = ?`,
      [nowIso, account.id, folderId, leaseToken],
    );
  }
}

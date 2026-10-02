import type { AuthorizedAccount } from '../../context/authorized-account.ts';

export type MailboxSyncStatus = 'idle' | 'syncing' | 'failed';

export interface MailboxSyncState {
  readonly accountId: string;
  readonly folderId: string;
  readonly mailboxPath: string;
  readonly uidValidity: number | null;
  readonly uidNext: number | null;
  readonly highestModSeq: number | null;
  readonly lastSyncedUid: number | null;
  readonly totalCount: number;
  readonly hasMoreOnServer: boolean;
  readonly syncStatus: MailboxSyncStatus;
  readonly lastSyncAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly lastError: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
}

export interface SyncStateRepository {
  getState(account: AuthorizedAccount, folderId: string): Promise<MailboxSyncState | null>;
  saveState(account: AuthorizedAccount, state: MailboxSyncState): Promise<void>;
  /**
   * Atomically acquires a per-mailbox sync lease.
   * If already leased by an unexpired token, returns false.
   */
  acquireLease(
    account: AuthorizedAccount,
    folderId: string,
    mailboxPath: string,
    leaseToken: string,
    durationMs: number,
  ): Promise<boolean>;
  releaseLease(account: AuthorizedAccount, folderId: string, leaseToken: string): Promise<void>;
}

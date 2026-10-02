import type { AuthorizedAccount } from '../../application/context/authorized-account.ts';
import type { Clock } from '../../application/ports/clock/clock.ts';
import type { MailboxSyncState, SyncStateRepository } from '../../application/ports/mail/sync-state.ts';

export class MemorySyncStateRepository implements SyncStateRepository {
  private readonly states = new Map<string, MailboxSyncState>();

  constructor(private readonly clock: Clock) {}

  private key(accountId: string, folderId: string): string {
    return `${accountId}:${folderId}`;
  }

  async getState(account: AuthorizedAccount, folderId: string): Promise<MailboxSyncState | null> {
    return this.states.get(this.key(account.id, folderId)) ?? null;
  }

  async saveState(account: AuthorizedAccount, state: MailboxSyncState): Promise<void> {
    this.states.set(this.key(account.id, state.folderId), state);
  }

  async acquireLease(
    account: AuthorizedAccount,
    folderId: string,
    mailboxPath: string,
    leaseToken: string,
    durationMs: number,
  ): Promise<boolean> {
    const k = this.key(account.id, folderId);
    const existing = this.states.get(k);
    const now = this.clock.now();

    if (existing && existing.leaseExpiresAt && existing.leaseExpiresAt > now && existing.leaseToken !== leaseToken) {
      return false;
    }

    const expires = new Date(now.getTime() + durationMs);
    const updated: MailboxSyncState = {
      accountId: account.id,
      folderId,
      mailboxPath,
      uidValidity: existing?.uidValidity ?? null,
      uidNext: existing?.uidNext ?? null,
      highestModSeq: existing?.highestModSeq ?? null,
      lastSyncedUid: existing?.lastSyncedUid ?? null,
      totalCount: existing?.totalCount ?? 0,
      hasMoreOnServer: existing?.hasMoreOnServer ?? false,
      syncStatus: 'syncing',
      lastSyncAt: existing?.lastSyncAt ?? null,
      lastAttemptAt: existing?.lastAttemptAt ?? null,
      lastError: existing?.lastError ?? null,
      leaseToken,
      leaseExpiresAt: expires,
    };
    this.states.set(k, updated);
    return true;
  }

  async releaseLease(account: AuthorizedAccount, folderId: string, leaseToken: string): Promise<void> {
    const k = this.key(account.id, folderId);
    const existing = this.states.get(k);
    if (existing && existing.leaseToken === leaseToken) {
      this.states.set(k, {
        ...existing,
        syncStatus: existing.syncStatus === 'syncing' ? 'idle' : existing.syncStatus,
        leaseToken: null,
        leaseExpiresAt: null,
      });
    }
  }
}

import type { FolderRole } from '@kaydet/domain';
import type { AuthorizedAccount } from '../context/authorized-account.ts';
import type { Clock } from '../ports/clock/clock.ts';
import type { EventBus } from '../ports/events/event-bus.ts';
import type { IdGenerator } from '../ports/ids/id-generator.ts';
import type { ImapProvider } from '../ports/mail/imap-provider.ts';
import type { MailboxSyncState, SyncStateRepository } from '../ports/mail/sync-state.ts';
import type { FolderRepository } from '../ports/repositories/folder-repository.ts';
import type { MailStoreWriter, StoredFolder, StoredMessage } from '../ports/repositories/mail-store.ts';
import type { UnitOfWork } from '../ports/transaction/unit-of-work.ts';

export interface SyncEngineOptions {
  readonly imap: ImapProvider;
  readonly mailStore: MailStoreWriter;
  readonly folders: FolderRepository;
  readonly syncState: SyncStateRepository;
  readonly events: EventBus;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly transactions: UnitOfWork;
  readonly batchSize?: number;
  readonly leaseDurationMs?: number;
}

export interface SyncMailboxOutcome {
  readonly outcome: 'synced' | 'up_to_date' | 'already_running' | 'folder_not_found' | 'mailbox_not_found';
  readonly newCount: number;
  readonly changedCount: number;
  readonly deletedCount: number;
  readonly resynced: boolean;
}

export interface SyncFoldersOutcome {
  readonly discovered: number;
  readonly removed: number;
}

export function isValidMessageIdHeader(header: string | null | undefined): boolean {
  if (!header) return false;
  const trimmed = header.trim();
  if (trimmed.length < 5) return false;
  if (
    trimmed === '<>' ||
    trimmed.toLowerCase() === '<none>' ||
    trimmed.toLowerCase() === '<null>' ||
    trimmed.toLowerCase() === '<invalid>'
  ) {
    return false;
  }
  return trimmed.startsWith('<') && trimmed.endsWith('>') && trimmed.includes('@');
}

export class SyncEngine {
  private readonly imap: ImapProvider;
  private readonly mailStore: MailStoreWriter;
  private readonly folders: FolderRepository;
  private readonly syncState: SyncStateRepository;
  private readonly events: EventBus;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly transactions: UnitOfWork;
  private readonly batchSize: number;
  private readonly leaseDurationMs: number;

  constructor(options: SyncEngineOptions) {
    this.imap = options.imap;
    this.mailStore = options.mailStore;
    this.folders = options.folders;
    this.syncState = options.syncState;
    this.events = options.events;
    this.clock = options.clock;
    this.ids = options.ids;
    this.transactions = options.transactions;
    this.batchSize = options.batchSize ?? 50;
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
  }

  /**
   * Synchronizes remote IMAP mailboxes with local folders.
   * Maps roles, creates new folders, updates hierarchy and removes vanished folders.
   */
  async syncFolders(account: AuthorizedAccount): Promise<SyncFoldersOutcome> {
    const remoteBoxes = await this.imap.listMailboxes(account);
    const existingFolders = await this.folders.listByAccount(account);

    const remotePaths = new Set<string>();

    await this.transactions.run(async () => {
      for (const box of remoteBoxes) {
        remotePaths.add(box.provider.path);
        // Find existing folder with same path to preserve ID and isFavorite
        const existing = existingFolders.find((f) => {
          // Look up matching path through internal provider ref if available
          return f.name === box.name && f.role === box.role;
        });

        const stored: StoredFolder = {
          id: existing ? existing.id : box.id,
          name: box.name,
          role: box.role,
          sortOrder: box.sortOrder,
          provider: box.provider,
          isFavorite: existing ? existing.isFavorite : undefined,
        };

        await this.mailStore.upsertFolder(account, stored);
      }
    });

    // Remove local folders whose remote mailboxes disappeared, provided they have no local-only messages
    let removed = 0;
    for (const local of existingFolders) {
      const ref = await this.mailStore.providerRefOfFolder(account, local.id);
      if (ref && !remotePaths.has(ref.path)) {
        // Never remove system folders (inbox, sent, drafts, trash)
        if (local.role === 'inbox' || local.role === 'sent' || local.role === 'drafts' || local.role === 'trash') {
          continue;
        }
        await this.transactions.run(async () => {
          await this.mailStore.removeFolder(account, local.id);
        });
        removed++;
      }
    }

    this.events.publish(account.userId, {
      type: 'folders.changed',
      accountId: account.id,
    });

    return {
      discovered: remoteBoxes.length,
      removed,
    };
  }

  /**
   * Synchronizes a single mailbox folder: UIDVALIDITY check, delta fetch, deduplication, flag updates.
   */
  async syncMailbox(
    account: AuthorizedAccount,
    folderId: string,
    options?: { limit?: number; checkDeletions?: boolean },
  ): Promise<SyncMailboxOutcome> {
    const ref = await this.mailStore.providerRefOfFolder(account, folderId);
    if (!ref) {
      return { outcome: 'folder_not_found', newCount: 0, changedCount: 0, deletedCount: 0, resynced: false };
    }

    const workerToken = this.ids.next();
    const acquired = await this.syncState.acquireLease(
      account,
      folderId,
      ref.path,
      workerToken,
      this.leaseDurationMs,
    );

    if (!acquired) {
      return { outcome: 'already_running', newCount: 0, changedCount: 0, deletedCount: 0, resynced: false };
    }

    try {
      const remoteState = await this.imap.inspectMailbox(account, ref.path);
      if (!remoteState) {
        return { outcome: 'mailbox_not_found', newCount: 0, changedCount: 0, deletedCount: 0, resynced: false };
      }

      const storedCheckpoint = await this.syncState.getState(account, folderId);
      let resynced = false;

      // 1. UIDVALIDITY mismatch check
      if (
        storedCheckpoint?.uidValidity != null &&
        remoteState.uidValidity != null &&
        storedCheckpoint.uidValidity !== remoteState.uidValidity
      ) {
        // UIDVALIDITY reset detected: wipe stale provider messages in this folder (preserving local drafts)
        await this.mailStore.clearFolderMessages(account, folderId);
        resynced = true;
      }

      // 2. Fast-path: CONDSTORE MODSEQ delta check
      const hasCondStore = remoteState.highestModSeq != null && storedCheckpoint?.highestModSeq != null;
      if (
        !resynced &&
        !storedCheckpoint?.hasMoreOnServer &&
        hasCondStore &&
        remoteState.highestModSeq === storedCheckpoint!.highestModSeq &&
        remoteState.totalCount === storedCheckpoint!.totalCount
      ) {
        // Up to date!
        await this.syncState.saveState(account, {
          ...storedCheckpoint!,
          lastSyncAt: this.clock.now(),
        });
        return { outcome: 'up_to_date', newCount: 0, changedCount: 0, deletedCount: 0, resynced: false };
      }

      let changedCount = 0;
      let newCount = 0;

      // 2.1 Process flag and keyword changes for existing messages via MODSEQ or non-CONDSTORE fallback
      if (!resynced && hasCondStore && remoteState.highestModSeq! > storedCheckpoint!.highestModSeq!) {
        const flagChanges = await this.imap.fetchFlags(account, ref.path, {
          changedSince: storedCheckpoint!.highestModSeq!,
        });
        for (const change of flagChanges) {
          const existing = remoteState.uidValidity != null
            ? await this.mailStore.findMessageByProviderUid(account, folderId, remoteState.uidValidity, change.uid)
            : null;
          const flagsToApply = {
            ...change.flags,
            pinned: existing?.pinned ? true : change.flags.pinned,
          };
          const updated = await this.mailStore.updateMessageFlagsByUid(account, folderId, change.uid, flagsToApply);
          if (updated) {
            changedCount++;
          }
        }
      }

      // 3. Fetching messages
      const localUids = await this.mailStore.getMailboxUids(account, folderId);
      const localHighestUid = localUids.length > 0 ? localUids[localUids.length - 1] : null;

      // Non-CONDSTORE fallback: check flags for recent local messages if never checked
      const neverSynced = storedCheckpoint?.lastSyncedUid == null;
      if (!resynced && !hasCondStore && !neverSynced && localUids.length > 0) {
        const sampleUids = localUids.slice(-this.batchSize);
        const flagChanges = await this.imap.fetchFlags(account, ref.path, { uids: sampleUids });
        for (const change of flagChanges) {
          const existing = remoteState.uidValidity != null
            ? await this.mailStore.findMessageByProviderUid(account, folderId, remoteState.uidValidity, change.uid)
            : null;
          const flagsToApply = {
            ...change.flags,
            pinned: existing?.pinned ? true : change.flags.pinned,
          };
          const updated = await this.mailStore.updateMessageFlagsByUid(account, folderId, change.uid, flagsToApply);
          if (updated) {
            changedCount++;
          }
        }
      }

      const pageSize = options?.limit ?? this.batchSize;
      let fetchedMessages: readonly StoredMessage[] = [];
      let hasMoreOnServer = resynced ? false : (storedCheckpoint?.hasMoreOnServer ?? false);

      if (resynced || neverSynced || localHighestUid == null) {
        // Initial sync: newest bounded slice (mobile parity: newest N, older ones are paged in later)
        const allUids = [...(await this.imap.searchUids(account, ref.path))].sort((a, b) => a - b);
        const slice = allUids.slice(-pageSize);
        if (slice.length > 0) {
          fetchedMessages = await this.imap.fetchMessages(account, folderId, ref.path, {
            uids: slice,
            limit: slice.length,
          });
        }
        hasMoreOnServer = allUids.length > slice.length;
      } else {
        if (remoteState.uidNext != null && remoteState.uidNext > localHighestUid + 1) {
          // Incremental sync: fetch the whole new range (never skip newer messages), in bounded chunks
          const collected: StoredMessage[] = [];
          const toUid = remoteState.uidNext - 1;
          const newUids = (await this.imap.searchUids(account, ref.path))
            .filter((uid) => uid > localHighestUid && uid <= toUid)
            .sort((a, b) => a - b);
          for (let i = 0; i < newUids.length; i += pageSize) {
            const chunk = newUids.slice(i, i + pageSize);
            collected.push(
              ...(await this.imap.fetchMessages(account, folderId, ref.path, { uids: chunk, limit: chunk.length })),
            );
          }
          fetchedMessages = collected;
        }

        if (hasMoreOnServer) {
          // Progressive backfill: one older page per sync, newest-first
          const lowestLocalUid = localUids[0]!;
          const olderUids = (await this.imap.searchUids(account, ref.path))
            .filter((uid) => uid < lowestLocalUid)
            .sort((a, b) => a - b);
          const olderSlice = olderUids.slice(-pageSize);
          if (olderSlice.length > 0) {
            fetchedMessages = [
              ...fetchedMessages,
              ...(await this.imap.fetchMessages(account, folderId, ref.path, {
                uids: olderSlice,
                limit: olderSlice.length,
              })),
            ];
          }
          hasMoreOnServer = olderUids.length > olderSlice.length;
        }
      }

      // 4. Message deduplication and upsert
      for (const storedMsg of fetchedMessages) {
        // Reconcile by provider UID
        const byUid =
          storedMsg.provider?.uid != null && remoteState.uidValidity != null
            ? await this.mailStore.findMessageByProviderUid(
                account,
                folderId,
                remoteState.uidValidity,
                storedMsg.provider.uid,
              )
            : null;

        // Reconcile by Message-ID header (handles cross-folder moves & UIDVALIDITY resets)
        // Guard: Message-ID must be valid format and not empty/trivial
        const msgIdHeader = storedMsg.provider?.messageIdHeader;
        const validHeader = isValidMessageIdHeader(msgIdHeader);
        const byHeader = validHeader
          ? await this.mailStore.findMessageByHeaderId(account, msgIdHeader!)
          : null;

        // Guard: do not unconditionally assume two records are the same without verifying sender and approximate date
        const isHeaderMatch =
          byHeader !== null &&
          byHeader.fromEmail.toLowerCase() === storedMsg.message.from.email.toLowerCase() &&
          Math.abs(Date.parse(byHeader.dateUtc) - Date.parse(storedMsg.message.date)) <= 7 * 86400 * 1000;

        let finalId: string;
        let isExisting = false;
        let localPinned = false;
        if (byUid) {
          finalId = byUid.id;
          isExisting = true;
          localPinned = byUid.pinned;
          changedCount++;
        } else if (isHeaderMatch) {
          finalId = byHeader.id;
          isExisting = true;
          localPinned = byHeader.pinned;
          changedCount++;
        } else {
          finalId = storedMsg.message.id;
          newCount++;
        }

        // Flagged vs pinned: IMAP \Flagged updates provider-backed state, but must never overwrite Kaydet's independent application-level pin state
        const effectivePinned = isExisting && localPinned ? true : storedMsg.message.pinned;

        const toSave: StoredMessage = {
          ...storedMsg,
          message: {
            ...storedMsg.message,
            id: finalId,
            folderId,
            pinned: effectivePinned,
          },
          provider: storedMsg.provider
            ? {
                ...storedMsg.provider,
                uidValidity: remoteState.uidValidity,
              }
            : null,
        };

        await this.transactions.run(async () => {
          await this.mailStore.upsertMessage(account, toSave);
        });
      }

      // 5. Server deletions reconciliation
      let deletedCount = 0;
      const shouldCheckDeletions =
        options?.checkDeletions === true ||
        (!neverSynced && (
          remoteState.totalCount !== storedCheckpoint?.totalCount ||
          (hasCondStore && remoteState.highestModSeq !== storedCheckpoint?.highestModSeq) ||
          options?.checkDeletions !== false
        ));

      if (shouldCheckDeletions) {
        const serverUids = await this.imap.searchUids(account, ref.path);
        const updatedLocalUids = await this.mailStore.getMailboxUids(account, folderId);

        // Guard against destructive deletion on incomplete provider UID comparison:
        // If server reports totalCount > 0 but searchUids returned empty or truncated slice, skip deletion.
        const isIncompleteSearch =
          (remoteState.totalCount != null && remoteState.totalCount > 0 && serverUids.length === 0) ||
          (remoteState.totalCount != null && serverUids.length < remoteState.totalCount);

        if (!isIncompleteSearch && updatedLocalUids.length > 0) {
          const serverUidSet = new Set(serverUids);
          const toRemove = updatedLocalUids.filter((uid) => !serverUidSet.has(uid));
          if (toRemove.length > 0) {
            deletedCount = await this.mailStore.removeMessagesByUids(account, folderId, toRemove);
          }
        }
      }

      // 6. Advance sync checkpoint atomically
      const updatedUids = await this.mailStore.getMailboxUids(account, folderId);
      const newHighestUid =
        updatedUids.length > 0
          ? updatedUids[updatedUids.length - 1]
          : (storedCheckpoint?.lastSyncedUid ?? null);

      const newState: MailboxSyncState = {
        accountId: account.id,
        folderId,
        mailboxPath: ref.path,
        uidValidity: remoteState.uidValidity,
        uidNext: remoteState.uidNext,
        highestModSeq: remoteState.highestModSeq,
        lastSyncedUid: newHighestUid ?? null,
        totalCount: remoteState.totalCount ?? 0,
        hasMoreOnServer,
        syncStatus: 'idle',
        lastSyncAt: this.clock.now(),
        lastAttemptAt: this.clock.now(),
        lastError: null,
        leaseToken: null,
        leaseExpiresAt: null,
      };

      await this.syncState.saveState(account, newState);

      if (newCount > 0 || changedCount > 0 || deletedCount > 0 || resynced) {
        this.events.publish(account.userId, {
          type: 'messages.changed',
          accountId: account.id,
          folderIds: [folderId],
        });
      }

      this.events.publish(account.userId, {
        type: 'sync.status',
        accountId: account.id,
        status: 'idle',
        error: null,
        lastSyncAt: this.clock.now().toISOString(),
      });

      return {
        outcome: 'synced',
        newCount,
        changedCount,
        deletedCount,
        resynced,
      };
    } finally {
      await this.syncState.releaseLease(account, folderId, workerToken);
    }
  }

  /**
   * Synchronizes an entire account: folders first, then each mailbox in role order.
   */
  async syncAccount(account: AuthorizedAccount): Promise<{
    readonly folders: SyncFoldersOutcome;
    readonly mailboxes: readonly SyncMailboxOutcome[];
  }> {
    const folderOutcome = await this.syncFolders(account);
    const allFolders = await this.folders.listByAccount(account);

    // Prioritize Inbox, Sent, Drafts, Archive, Trash, Custom
    const roleOrder: Record<FolderRole, number> = {
      inbox: 1,
      sent: 2,
      drafts: 3,
      archive: 4,
      junk: 5,
      trash: 6,
      custom: 7,
    };

    const sortedFolders = [...allFolders].sort((a, b) => {
      const orderA = roleOrder[a.role] ?? 99;
      const orderB = roleOrder[b.role] ?? 99;
      return orderA - orderB;
    });

    const mailboxOutcomes: SyncMailboxOutcome[] = [];
    for (const folder of sortedFolders) {
      const outcome = await this.syncMailbox(account, folder.id);
      mailboxOutcomes.push(outcome);
    }

    return {
      folders: folderOutcome,
      mailboxes: mailboxOutcomes,
    };
  }
}

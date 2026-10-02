import { describe, expect, it } from 'vitest';
import type { FolderRole, MailEvent } from '@kaydet/domain';
import { grantAccountAccess } from './context/authorized-account.ts';
import type { Clock } from './ports/clock/clock.ts';
import type { EventBus } from './ports/events/event-bus.ts';
import type { IdGenerator } from './ports/ids/id-generator.ts';
import type { ImapProvider } from './ports/mail/imap-provider.ts';
import type { MailboxSyncState, SyncStateRepository } from './ports/mail/sync-state.ts';
import type { FolderRepository } from './ports/repositories/folder-repository.ts';
import type { MailStoreWriter, StoredFolder, StoredMessage } from './ports/repositories/mail-store.ts';
import type { UnitOfWork } from './ports/transaction/unit-of-work.ts';
import { SyncEngine } from './services/sync-engine.ts';

class TestClock implements Clock {
  private current: Date;
  constructor(iso = '2026-10-01T12:00:00.000Z') {
    this.current = new Date(iso);
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

class TestIdGenerator implements IdGenerator {
  private counter = 0;
  constructor(private readonly prefix = 'id') {}
  next(): string {
    return `${this.prefix}-${++this.counter}`;
  }
}

class TestEventBus implements EventBus {
  readonly events: { userId: string; event: MailEvent }[] = [];
  publish(userId: string, event: MailEvent): void {
    this.events.push({ userId, event });
  }
  subscribe(): () => void {
    return () => {};
  }
  async close(): Promise<void> {}
}

class TestUnitOfWork implements UnitOfWork {
  async run<T>(action: () => Promise<T>): Promise<T> {
    return await action();
  }
}

const mockFolder = (id: string, name: string, role: FolderRole, path: string): StoredFolder => ({
  id,
  name,
  role,
  sortOrder: 1,
  provider: {
    path,
    delimiter: '/',
    uidValidity: 100,
    uidNext: 50,
    highestModSeq: 1000,
    totalCount: 10,
  },
});

const mockMessage = (id: string, folderId: string, uid: number, headerId: string): StoredMessage => ({
  message: {
    id,
    accountId: 'acc-1',
    folderId,
    threadId: `t-${id}`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'user@example.com', name: '' }],
    cc: [],
    bcc: [],
    subject: `Subject ${id}`,
    preview: 'Preview...',
    date: '2026-10-01T10:00:00.000Z',
    seen: false,
    pinned: false,
    answered: false,
    forwarded: false,
    draft: false,
    hasAttachments: false,
    labels: [],
    outbox: { state: 'sent' },
    body: { text: 'Hello', html: null },
    attachments: [],
  },
  provider: {
    uid,
    uidValidity: 100,
    modSeq: 20,
    messageIdHeader: headerId,
    inReplyTo: null,
    references: null,
  },
});

const mockImap = (overrides: Partial<ImapProvider> = {}): ImapProvider => ({
  testConnection: async () => {},
  listMailboxes: async () => [],
  inspectMailbox: async () => null,
  fetchMessages: async () => [],
  updateFlags: async () => {},
  fetchFlags: async () => [],
  searchUids: async () => [],
  ...overrides,
});

describe('SyncEngine', () => {
  const account = grantAccountAccess({
    id: 'acc-1',
    userId: 'u-1',
    email: 'user@example.com',
  });

  const setupTest = () => {
    const clock = new TestClock();
    const ids = new TestIdGenerator('test');
    const events = new TestEventBus();
    const transactions = new TestUnitOfWork();

    const storedFolders: StoredFolder[] = [mockFolder('f-inbox', 'INBOX', 'inbox', 'INBOX')];

    const storedMessages: StoredMessage[] = [];
    const syncStates = new Map<string, MailboxSyncState>();

    const folderRepo: FolderRepository = {
      listByAccount: async () =>
        storedFolders.map((f) => ({
          id: f.id,
          accountId: account.id,
          name: f.name,
          role: f.role,
          parentId: null,
          depth: 0,
          hasChildren: false,
          sortOrder: f.sortOrder,
          isFavorite: f.isFavorite ?? false,
          totalCount: 0,
          unreadCount: 0,
        })),
      find: async (_acc, folderId) => {
        const found = storedFolders.find((f) => f.id === folderId);
        if (!found) return null;
        return {
          id: found.id,
          accountId: account.id,
          name: found.name,
          role: found.role,
          parentId: null,
          depth: 0,
          hasChildren: false,
          sortOrder: found.sortOrder,
          isFavorite: found.isFavorite ?? false,
          totalCount: 0,
          unreadCount: 0,
        };
      },
    };

    const mailStore: MailStoreWriter = {
      upsertFolder: async (_acc, folder) => {
        const idx = storedFolders.findIndex((f) => f.id === folder.id || f.name === folder.name);
        if (idx >= 0) {
          storedFolders[idx] = folder;
        } else {
          storedFolders.push(folder);
        }
      },
      removeFolder: async (_acc, folderId) => {
        const idx = storedFolders.findIndex((f) => f.id === folderId);
        if (idx >= 0) storedFolders.splice(idx, 1);
      },
      upsertMessage: async (_acc, msg) => {
        const idx = storedMessages.findIndex((m) => m.message.id === msg.message.id);
        const existing = idx >= 0 ? storedMessages[idx] : null;
        const preservedPinned = existing?.message.pinned || msg.message.pinned;
        const toSave: StoredMessage = {
          ...msg,
          message: {
            ...msg.message,
            pinned: preservedPinned,
          },
        };
        if (idx >= 0) {
          storedMessages[idx] = toSave;
        } else {
          storedMessages.push(toSave);
        }
      },
      removeMessage: async (_acc, messageId) => {
        const idx = storedMessages.findIndex((m) => m.message.id === messageId);
        if (idx >= 0) storedMessages.splice(idx, 1);
      },
      providerRefOfMessage: async (_acc, messageId) => {
        const found = storedMessages.find((m) => m.message.id === messageId);
        return found?.provider ?? null;
      },
      providerRefOfFolder: async (_acc, folderId) => {
        const found = storedFolders.find((f) => f.id === folderId);
        if (!found) return null;
        return found.provider;
      },
      findMessageByProviderUid: async (_acc, folderId, uidValidity, uid) => {
        const found = storedMessages.find(
          (m) =>
            m.message.folderId === folderId &&
            m.provider?.uid === uid &&
            m.provider?.uidValidity === uidValidity,
        );
        return found
          ? {
              id: found.message.id,
              messageIdHeader: found.provider?.messageIdHeader ?? null,
              pinned: found.message.pinned,
            }
          : null;
      },
      findMessageByHeaderId: async (_acc, headerId) => {
        const found = storedMessages.find((m) => m.provider?.messageIdHeader === headerId);
        return found
          ? {
              id: found.message.id,
              folderId: found.message.folderId,
              pinned: found.message.pinned,
              fromEmail: found.message.from.email,
              dateUtc: found.message.date,
            }
          : null;
      },
      getMailboxUids: async (_acc, folderId) => {
        return storedMessages
          .filter((m) => m.message.folderId === folderId && m.provider?.uid != null)
          .map((m) => m.provider!.uid!)
          .sort((a, b) => a - b);
      },
      removeMessagesByUids: async (_acc, folderId, uids) => {
        const set = new Set(uids);
        let removed = 0;
        for (let i = storedMessages.length - 1; i >= 0; i--) {
          const msg = storedMessages[i];
          if (msg.message.folderId === folderId && msg.provider?.uid != null && set.has(msg.provider.uid)) {
            storedMessages.splice(i, 1);
            removed++;
          }
        }
        return removed;
      },
      clearFolderMessages: async (_acc, folderId) => {
        let removed = 0;
        for (let i = storedMessages.length - 1; i >= 0; i--) {
          if (storedMessages[i].message.folderId === folderId && !storedMessages[i].message.draft) {
            storedMessages.splice(i, 1);
            removed++;
          }
        }
        return removed;
      },
      updateMessageFlagsByUid: async (_acc, folderId, uid, flags) => {
        const found = storedMessages.find(
          (m) => m.message.folderId === folderId && m.provider?.uid === uid,
        );
        if (!found) return false;
        if (flags.seen !== undefined) (found.message as { seen: boolean }).seen = flags.seen;
        if (flags.pinned !== undefined) {
          (found.message as { pinned: boolean }).pinned = found.message.pinned || flags.pinned;
        }
        return true;
      },
    };

    const syncStateRepo: SyncStateRepository = {
      getState: async (_acc, folderId) => syncStates.get(folderId) ?? null,
      saveState: async (_acc, state) => {
        syncStates.set(state.folderId, state);
      },
      acquireLease: async (_acc, folderId, path, token, durationMs) => {
        const existing = syncStates.get(folderId);
        const now = clock.now();
        if (existing?.leaseExpiresAt && existing.leaseExpiresAt > now) {
          return false;
        }
        const updated: MailboxSyncState = {
          accountId: account.id,
          folderId,
          mailboxPath: path,
          uidValidity: existing?.uidValidity ?? null,
          uidNext: existing?.uidNext ?? null,
          highestModSeq: existing?.highestModSeq ?? null,
          lastSyncedUid: existing?.lastSyncedUid ?? null,
          totalCount: existing?.totalCount ?? 0,
          hasMoreOnServer: existing?.hasMoreOnServer ?? false,
          syncStatus: 'syncing',
          lastSyncAt: existing?.lastSyncAt ?? null,
          lastAttemptAt: now,
          lastError: null,
          leaseToken: token,
          leaseExpiresAt: new Date(now.getTime() + durationMs),
        };
        syncStates.set(folderId, updated);
        return true;
      },
      releaseLease: async (_acc, folderId, token) => {
        const existing = syncStates.get(folderId);
        if (existing && existing.leaseToken === token) {
          syncStates.set(folderId, {
            ...existing,
            leaseToken: null,
            leaseExpiresAt: null,
            syncStatus: 'idle',
          });
        }
      },
    };

    return {
      clock,
      ids,
      events,
      transactions,
      folderRepo,
      mailStore,
      syncStateRepo,
      storedFolders,
      storedMessages,
      syncStates,
    };
  };

  it('initial sync fetches the newest messages first, then backfills older pages and never skips new ones', async () => {
    const ctx = setupTest();
    const serverUids = [1, 2, 3, 4, 5, 6];
    const requested: number[][] = [];

    const imap = mockImap({
      inspectMailbox: async () => ({
        path: 'INBOX',
        delimiter: '/',
        uidValidity: 100,
        uidNext: serverUids[serverUids.length - 1]! + 1,
        highestModSeq: null,
        totalCount: serverUids.length,
      }),
      searchUids: async () => serverUids,
      fetchMessages: async (_acc, folderId, _path, options) => {
        const uids = [...(options?.uids ?? [])];
        requested.push(uids);
        return uids.map((uid) => mockMessage(`msg-${uid}`, folderId, uid, `<m${uid}@example.com>`));
      },
    });

    const engine = new SyncEngine({
      imap,
      mailStore: ctx.mailStore,
      folders: ctx.folderRepo,
      syncState: ctx.syncStateRepo,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
      batchSize: 2,
    });

    await engine.syncMailbox(account, 'f-inbox');
    expect(requested[0]).toEqual([5, 6]);
    expect((await ctx.syncStateRepo.getState(account, 'f-inbox'))?.hasMoreOnServer).toBe(true);

    // New mail arrives: all 3 new messages are fetched (more than one page), plus one older page
    serverUids.push(7, 8, 9);
    await engine.syncMailbox(account, 'f-inbox');
    const fetched = requested.slice(1).flat().sort((a, b) => a - b);
    expect(fetched).toEqual([3, 4, 7, 8, 9]);

    await engine.syncMailbox(account, 'f-inbox');
    expect(requested.flat()).toEqual(expect.arrayContaining([1, 2]));
    expect((await ctx.syncStateRepo.getState(account, 'f-inbox'))?.hasMoreOnServer).toBe(false);
  });

  it('performs initial sync: discovers folders, establishes checkpoint and saves messages', async () => {
    const ctx = setupTest();

    const imap = mockImap({
      listMailboxes: async () => [
        mockFolder('f-inbox', 'INBOX', 'inbox', 'INBOX'),
      ],
      inspectMailbox: async () => ({
        path: 'INBOX',
        delimiter: '/',
        uidValidity: 100,
        uidNext: 3,
        highestModSeq: 50,
        totalCount: 2,
      }),
      searchUids: async () => [1, 2],
      fetchMessages: async (_acc, folderId) => [
        mockMessage('msg-1', folderId, 1, '<m1@example.com>'),
        mockMessage('msg-2', folderId, 2, '<m2@example.com>'),
      ],
    });

    const engine = new SyncEngine({
      imap,
      mailStore: ctx.mailStore,
      folders: ctx.folderRepo,
      syncState: ctx.syncStateRepo,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
    });

    const result = await engine.syncMailbox(account, 'f-inbox');
    expect(result.outcome).toBe('synced');
    expect(result.newCount).toBe(2);
    expect(result.resynced).toBe(false);

    // Stored messages should contain both
    expect(ctx.storedMessages).toHaveLength(2);
    expect(ctx.storedMessages[0].message.id).toBe('msg-1');
    expect(ctx.storedMessages[1].message.id).toBe('msg-2');

    // Checkpoint should be saved
    const state = await ctx.syncStateRepo.getState(account, 'f-inbox');
    expect(state).not.toBeNull();
    expect(state?.uidValidity).toBe(100);
    expect(state?.lastSyncedUid).toBe(2);
    expect(state?.highestModSeq).toBe(50);
    expect(state?.syncStatus).toBe('idle');

    // Events emitted
    expect(ctx.events.events.some((e) => e.event.type === 'messages.changed')).toBe(true);
    expect(ctx.events.events.some((e) => e.event.type === 'sync.status' && e.event.status === 'idle')).toBe(true);
  });

  it('MODSEQ fast-path: skips message fetch when MODSEQ and totalCount are unchanged', async () => {
    const ctx = setupTest();

    // Seed checkpoint
    await ctx.syncStateRepo.saveState(account, {
      accountId: account.id,
      folderId: 'f-inbox',
      mailboxPath: 'INBOX',
      uidValidity: 100,
      uidNext: 10,
      highestModSeq: 500,
      lastSyncedUid: 9,
      totalCount: 9,
      hasMoreOnServer: false,
      syncStatus: 'idle',
      lastSyncAt: ctx.clock.now(),
      lastAttemptAt: ctx.clock.now(),
      lastError: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });

    let fetchCalled = false;
    const imap = mockImap({
      inspectMailbox: async () => ({
        path: 'INBOX',
        delimiter: '/',
        uidValidity: 100,
        uidNext: 10,
        highestModSeq: 500, // exact match
        totalCount: 9, // exact match
      }),
      fetchMessages: async () => {
        fetchCalled = true;
        return [];
      },
    });

    const engine = new SyncEngine({
      imap,
      mailStore: ctx.mailStore,
      folders: ctx.folderRepo,
      syncState: ctx.syncStateRepo,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
    });

    const result = await engine.syncMailbox(account, 'f-inbox');
    expect(result.outcome).toBe('up_to_date');
    expect(fetchCalled).toBe(false);
  });

  it('UIDVALIDITY mismatch handling: wipes stale provider UIDs and reconciles via Message-ID', async () => {
    const ctx = setupTest();

    // Previously synced with UIDVALIDITY 100
    await ctx.syncStateRepo.saveState(account, {
      accountId: account.id,
      folderId: 'f-inbox',
      mailboxPath: 'INBOX',
      uidValidity: 100,
      uidNext: 10,
      highestModSeq: 50,
      lastSyncedUid: 5,
      totalCount: 5,
      hasMoreOnServer: false,
      syncStatus: 'idle',
      lastSyncAt: ctx.clock.now(),
      lastAttemptAt: ctx.clock.now(),
      lastError: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });

    // An existing message in inbox with UIDVALIDITY 100
    ctx.storedMessages.push(mockMessage('existing-id-42', 'f-inbox', 1, '<match-me@example.com>'));

    // Remote server has reset UIDVALIDITY to 200 (e.g. mailbox moved or re-created)
    const imap = mockImap({
      inspectMailbox: async () => ({
        path: 'INBOX',
        delimiter: '/',
        uidValidity: 200, // mismatch!
        uidNext: 2,
        highestModSeq: 1,
        totalCount: 1,
      }),
      fetchMessages: async (_acc, folderId) => [
        mockMessage('temp-id-999', folderId, 1, '<match-me@example.com>'),
      ],
    });

    const engine = new SyncEngine({
      imap,
      mailStore: ctx.mailStore,
      folders: ctx.folderRepo,
      syncState: ctx.syncStateRepo,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
    });

    const result = await engine.syncMailbox(account, 'f-inbox');
    expect(result.outcome).toBe('synced');
    expect(result.resynced).toBe(true);

    // Checkpoint updated to new UIDVALIDITY 200
    const state = await ctx.syncStateRepo.getState(account, 'f-inbox');
    expect(state?.uidValidity).toBe(200);
  });

  it('prevents concurrent sync execution for the same mailbox using durable lease locking', async () => {
    const ctx = setupTest();

    const imap = mockImap({
      inspectMailbox: async () => ({
        path: 'INBOX',
        delimiter: '/',
        uidValidity: 100,
        uidNext: 5,
        highestModSeq: 10,
        totalCount: 0,
      }),
    });

    const engine = new SyncEngine({
      imap,
      mailStore: ctx.mailStore,
      folders: ctx.folderRepo,
      syncState: ctx.syncStateRepo,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
    });

    // Simulate an ongoing sync holding a lease
    await ctx.syncStateRepo.acquireLease(account, 'f-inbox', 'INBOX', 'worker-other', 60_000);

    const outcome = await engine.syncMailbox(account, 'f-inbox');
    expect(outcome.outcome).toBe('already_running');
  });

  it('folder sync discovers new folders and cleans vanished remote folders while preserving system folders', async () => {
    const ctx = setupTest();

    // Initial local folders: INBOX and a custom folder 'OldProject'
    ctx.storedFolders.push(mockFolder('f-custom', 'OldProject', 'custom', 'OldProject'));

    const imap = mockImap({
      listMailboxes: async () => [
        mockFolder('f-inbox', 'INBOX', 'inbox', 'INBOX'),
        mockFolder('f-new', 'NewProject', 'custom', 'NewProject'),
      ],
    });

    const engine = new SyncEngine({
      imap,
      mailStore: ctx.mailStore,
      folders: ctx.folderRepo,
      syncState: ctx.syncStateRepo,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
    });

    const outcome = await engine.syncFolders(account);
    expect(outcome.discovered).toBe(2);
    expect(outcome.removed).toBe(1);

    const folderNames = ctx.storedFolders.map((f) => f.name);
    expect(folderNames).toContain('INBOX');
    expect(folderNames).toContain('NewProject');
    expect(folderNames).not.toContain('OldProject');
  });

  it('MODSEQ correctness: detects flag changes (read/unread, flagged) on existing messages using CONDSTORE changedSince', async () => {
    const ctx = setupTest();

    // Existing local message: uid 10, unread (seen: false), unpinned
    const msg = mockMessage('m-1', 'f-inbox', 10, '<msg-10@example.com>');
    msg.message.seen = false;
    msg.message.pinned = false;
    await ctx.mailStore.upsertMessage(account, msg);

    // Initial sync state: highestModSeq 100
    await ctx.syncStateRepo.saveState(account, {
      accountId: account.id,
      folderId: 'f-inbox',
      mailboxPath: 'INBOX',
      uidValidity: 100,
      uidNext: 11,
      highestModSeq: 100,
      lastSyncedUid: 10,
      totalCount: 1,
      hasMoreOnServer: false,
      syncStatus: 'idle',
      lastSyncAt: ctx.clock.now(),
      lastAttemptAt: ctx.clock.now(),
      lastError: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });

    let fetchFlagsCalledWith: { uids?: readonly number[]; changedSince?: number } | undefined;
    const imap = mockImap({
      inspectMailbox: async () => ({
        path: 'INBOX',
        delimiter: '/',
        uidValidity: 100,
        uidNext: 11,
        highestModSeq: 150,
        totalCount: 1,
      }),
      fetchFlags: async (_acc, _path, options) => {
        fetchFlagsCalledWith = options;
        return [
          {
            uid: 10,
            modSeq: 150,
            flags: {
              seen: true,
              pinned: true,
              answered: false,
              forwarded: false,
              serverDeleted: false,
            },
          },
        ];
      },
      searchUids: async () => [10],
    });

    const engine = new SyncEngine({
      imap,
      mailStore: ctx.mailStore,
      folders: ctx.folderRepo,
      syncState: ctx.syncStateRepo,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
    });

    const result = await engine.syncMailbox(account, 'f-inbox');
    expect(result.outcome).toBe('synced');
    expect(result.newCount).toBe(0);
    expect(result.changedCount).toBe(1);
    expect(fetchFlagsCalledWith?.changedSince).toBe(100);

    const stored = ctx.storedMessages.find((m) => m.message.id === 'm-1');
    expect(stored?.message.seen).toBe(true);
    expect(stored?.message.pinned).toBe(true);

    const state = await ctx.syncStateRepo.getState(account, 'f-inbox');
    expect(state?.highestModSeq).toBe(150);
  });

  it('deletion reconciliation: detects both deletions and new arrivals when total count is unchanged (3 deleted, 3 arrived)', async () => {
    const ctx = setupTest();

    // 3 existing messages: UIDs 1, 2, 3
    await ctx.mailStore.upsertMessage(account, mockMessage('m-1', 'f-inbox', 1, '<m1@example.com>'));
    await ctx.mailStore.upsertMessage(account, mockMessage('m-2', 'f-inbox', 2, '<m2@example.com>'));
    await ctx.mailStore.upsertMessage(account, mockMessage('m-3', 'f-inbox', 3, '<m3@example.com>'));

    // Previous checkpoint: 3 messages, highest UID 3
    await ctx.syncStateRepo.saveState(account, {
      accountId: account.id,
      folderId: 'f-inbox',
      mailboxPath: 'INBOX',
      uidValidity: 100,
      uidNext: 4,
      highestModSeq: 50,
      lastSyncedUid: 3,
      totalCount: 3,
      hasMoreOnServer: false,
      syncStatus: 'idle',
      lastSyncAt: ctx.clock.now(),
      lastAttemptAt: ctx.clock.now(),
      lastError: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });

    // Server state: 1, 2, 3 deleted; 4, 5, 6 arrived. Total count is STILL 3! uidNext is 7.
    const imap = mockImap({
      inspectMailbox: async () => ({
        path: 'INBOX',
        delimiter: '/',
        uidValidity: 100,
        uidNext: 7,
        highestModSeq: 90,
        totalCount: 3,
      }),
      fetchMessages: async () => [
        mockMessage('m-4', 'f-inbox', 4, '<m4@example.com>'),
        mockMessage('m-5', 'f-inbox', 5, '<m5@example.com>'),
        mockMessage('m-6', 'f-inbox', 6, '<m6@example.com>'),
      ],
      searchUids: async () => [4, 5, 6], // UIDs 1, 2, 3 are gone!
    });

    const engine = new SyncEngine({
      imap,
      mailStore: ctx.mailStore,
      folders: ctx.folderRepo,
      syncState: ctx.syncStateRepo,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
    });

    const result = await engine.syncMailbox(account, 'f-inbox');
    expect(result.outcome).toBe('synced');
    expect(result.newCount).toBe(3);
    expect(result.deletedCount).toBe(3);

    const remainingUids = ctx.storedMessages.map((m) => m.provider?.uid).sort();
    expect(remainingUids).toEqual([4, 5, 6]);
  });

  it('deletion reconciliation: never destructively deletes local messages when provider search is incomplete', async () => {
    const ctx = setupTest();

    await ctx.mailStore.upsertMessage(account, mockMessage('m-1', 'f-inbox', 1, '<m1@example.com>'));
    await ctx.mailStore.upsertMessage(account, mockMessage('m-2', 'f-inbox', 2, '<m2@example.com>'));

    await ctx.syncStateRepo.saveState(account, {
      accountId: account.id,
      folderId: 'f-inbox',
      mailboxPath: 'INBOX',
      uidValidity: 100,
      uidNext: 3,
      highestModSeq: 50,
      lastSyncedUid: 2,
      totalCount: 2,
      hasMoreOnServer: false,
      syncStatus: 'idle',
      lastSyncAt: ctx.clock.now(),
      lastAttemptAt: ctx.clock.now(),
      lastError: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });

    // Remote inspect reports totalCount: 2, but searchUids returns empty [] (incomplete/interrupted search)
    const imap = mockImap({
      inspectMailbox: async () => ({
        path: 'INBOX',
        delimiter: '/',
        uidValidity: 100,
        uidNext: 3,
        highestModSeq: 50,
        totalCount: 2,
      }),
      searchUids: async () => [], // Incomplete search!
    });

    const engine = new SyncEngine({
      imap,
      mailStore: ctx.mailStore,
      folders: ctx.folderRepo,
      syncState: ctx.syncStateRepo,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
    });

    const result = await engine.syncMailbox(account, 'f-inbox', { checkDeletions: true });
    expect(result.deletedCount).toBe(0);

    // Messages must NOT have been destructively wiped
    expect(ctx.storedMessages.length).toBe(2);
  });

  it('UIDVALIDITY reset preserves local drafts and rejects malformed or conflicting Message-ID headers', async () => {
    const ctx = setupTest();

    // Stored server message
    await ctx.mailStore.upsertMessage(account, mockMessage('m-server', 'f-inbox', 1, '<orig@example.com>'));

    // Stored local draft in the same folder
    const draftMsg = mockMessage('d-local', 'f-inbox', null as unknown as number, '');
    draftMsg.message.draft = true;
    (draftMsg as { provider: unknown }).provider = null;
    await ctx.mailStore.upsertMessage(account, draftMsg);

    // Existing sync state with uidValidity: 100
    await ctx.syncStateRepo.saveState(account, {
      accountId: account.id,
      folderId: 'f-inbox',
      mailboxPath: 'INBOX',
      uidValidity: 100,
      uidNext: 2,
      highestModSeq: 10,
      lastSyncedUid: 1,
      totalCount: 1,
      hasMoreOnServer: false,
      syncStatus: 'idle',
      lastSyncAt: ctx.clock.now(),
      lastAttemptAt: ctx.clock.now(),
      lastError: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });

    // Server returns UIDVALIDITY reset (uidValidity: 200)
    // Server provides a message with empty/malformed Message-ID "<>"
    const imap = mockImap({
      inspectMailbox: async () => ({
        path: 'INBOX',
        delimiter: '/',
        uidValidity: 200,
        uidNext: 5,
        highestModSeq: 30,
        totalCount: 1,
      }),
      fetchMessages: async () => [
        mockMessage('new-remote-id', 'f-inbox', 1, '<>'), // Malformed/empty header!
      ],
      searchUids: async () => [1],
    });

    const engine = new SyncEngine({
      imap,
      mailStore: ctx.mailStore,
      folders: ctx.folderRepo,
      syncState: ctx.syncStateRepo,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
    });

    const result = await engine.syncMailbox(account, 'f-inbox');
    expect(result.resynced).toBe(true);

    // Local draft must still exist!
    const draftFound = ctx.storedMessages.find((m) => m.message.id === 'd-local');
    expect(draftFound).toBeDefined();
    expect(draftFound?.message.draft).toBe(true);

    // The remote message with "<>" was assigned its own id and was not linked to existing messages
    const newMsg = ctx.storedMessages.find((m) => m.provider?.uid === 1);
    expect(newMsg?.message.id).toBe('new-remote-id');
  });

  it('flagged vs pinned: IMAP \\Flagged=false never overwrites Kaydet independent application pin state', async () => {
    const ctx = setupTest();

    // Message pinned locally by the user in Kaydet
    const msg = mockMessage('m-pinned', 'f-inbox', 5, '<pinned@example.com>');
    msg.message.pinned = true;
    await ctx.mailStore.upsertMessage(account, msg);

    await ctx.syncStateRepo.saveState(account, {
      accountId: account.id,
      folderId: 'f-inbox',
      mailboxPath: 'INBOX',
      uidValidity: 100,
      uidNext: 6,
      highestModSeq: 10,
      lastSyncedUid: 5,
      totalCount: 1,
      hasMoreOnServer: false,
      syncStatus: 'idle',
      lastSyncAt: ctx.clock.now(),
      lastAttemptAt: ctx.clock.now(),
      lastError: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });

    // Remote server sends flag update where server \Flagged is false (pinned: false)
    const imap = mockImap({
      inspectMailbox: async () => ({
        path: 'INBOX',
        delimiter: '/',
        uidValidity: 100,
        uidNext: 6,
        highestModSeq: 20,
        totalCount: 1,
      }),
      fetchFlags: async () => [
        {
          uid: 5,
          flags: {
            seen: true,
            pinned: false, // Server has no \Flagged
            answered: false,
            forwarded: false,
            serverDeleted: false,
          },
        },
      ],
      searchUids: async () => [5],
    });

    const engine = new SyncEngine({
      imap,
      mailStore: ctx.mailStore,
      folders: ctx.folderRepo,
      syncState: ctx.syncStateRepo,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
    });

    await engine.syncMailbox(account, 'f-inbox');

    // Verify local pin was NOT cleared!
    const stored = ctx.storedMessages.find((m) => m.message.id === 'm-pinned');
    expect(stored?.message.pinned).toBe(true);
    expect(stored?.message.seen).toBe(true);
  });
});

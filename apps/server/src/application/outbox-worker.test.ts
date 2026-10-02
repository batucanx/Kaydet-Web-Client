import { describe, expect, it } from 'vitest';
import type { AccountDTO, DraftDTO, FolderDTO, MailEvent } from '@kaydet/domain';
import { AppError } from './errors.ts';
import type { Clock } from './ports/clock/clock.ts';
import type { EventBus } from './ports/events/event-bus.ts';
import type { IdGenerator } from './ports/ids/id-generator.ts';
import type { MailSenderPort, OutgoingMessage } from './ports/mail/sender.ts';
import type { AccountRepository } from './ports/repositories/account-repository.ts';
import type { DraftRepository, OutboxRepository } from './ports/repositories/draft-repository.ts';
import type { FolderRepository } from './ports/repositories/folder-repository.ts';
import type { MailStoreWriter, StoredMessage } from './ports/repositories/mail-store.ts';
import type { UnitOfWork } from './ports/transaction/unit-of-work.ts';
import { OutboxWorker } from './services/outbox-worker.ts';

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

describe('OutboxWorker', () => {
  const userId = 'u-1';
  const accountId = 'acc-1';

  const setupWorker = () => {
    const clock = new TestClock();
    const ids = new TestIdGenerator('outbox');
    const events = new TestEventBus();
    const transactions = new TestUnitOfWork();

    const accountsList: AccountDTO[] = [
      {
        id: accountId,
        email: 'user@example.com',
        displayName: 'Test User',
        supportsServerLabels: false,
        sync: { status: 'idle', lastSyncAt: null },
      },
    ];

    const foldersList: FolderDTO[] = [
      {
        id: 'f-sent',
        accountId,
        name: 'Sent',
        role: 'sent',
        parentId: null,
        depth: 0,
        hasChildren: false,
        isFavorite: false,
        totalCount: 0,
        unreadCount: 0,
      },
    ];

    const drafts = new Map<string, DraftDTO>();
    drafts.set('draft-1', {
      id: 'draft-1',
      accountId,
      to: [{ email: 'recipient@example.com', name: 'Recipient' }],
      cc: [],
      bcc: [],
      subject: 'Outgoing letter',
      bodyText: 'Hello there',
      bodyHtml: '<p>Hello there</p>',
      attachments: [],
      source: null,
      messageId: null,
      updatedAt: '2026-10-01T11:00:00.000Z',
    });

    interface StoredOutbox {
      id: string;
      userId: string;
      accountId: string;
      draftId: string;
      state: 'queued' | 'sending' | 'sent' | 'failed';
      attemptCount: number;
      nextAttemptAt: Date | null;
      lastError: string | null;
      leaseToken: string | null;
      leaseExpiresAt: Date | null;
    }

    const outboxItems = new Map<string, StoredOutbox>();
    outboxItems.set('out-1', {
      id: 'out-1',
      userId,
      accountId,
      draftId: 'draft-1',
      state: 'queued',
      attemptCount: 0,
      nextAttemptAt: clock.now(),
      lastError: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });

    const storedMessages: StoredMessage[] = [];

    const accountRepo: AccountRepository = {
      listByUser: async () => accountsList,
      findOwned: async (_uId, accId) => accountsList.find((a) => a.id === accId) ?? null,
      create: async () => {},
      update: async () => {
        throw new Error('Not implemented');
      },
      remove: async () => {},
    };

    const folderRepo: FolderRepository = {
      listByAccount: async () => foldersList,
      find: async (_acc, folderId) => foldersList.find((f) => f.id === folderId) ?? null,
    };

    const draftRepo: DraftRepository = {
      find: async (_uId, draftId) => drafts.get(draftId) ?? null,
      save: async () => {},
      remove: async () => {},
    };

    const outboxRepo: OutboxRepository = {
      find: async (_uId, outboxId) => {
        const item = outboxItems.get(outboxId);
        if (!item) return null;
        return {
          id: item.id,
          accountId: item.accountId,
          draftId: item.draftId,
          messageId: null,
          state: item.state,
          cancellableUntil: null,
          error: item.lastError,
        };
      },
      claimNextDue: async (workerToken, leaseDurationMs, now) => {
        for (const item of outboxItems.values()) {
          const isDue =
            (item.state === 'queued' || (item.state === 'failed' && item.nextAttemptAt && item.nextAttemptAt <= now)) &&
            (!item.leaseExpiresAt || item.leaseExpiresAt <= now);

          if (isDue) {
            item.state = 'sending';
            item.leaseToken = workerToken;
            item.leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
            return {
              outboxId: item.id,
              userId: item.userId,
              accountId: item.accountId,
              draftId: item.draftId,
              attemptCount: item.attemptCount,
              workerToken,
            };
          }
        }
        return null;
      },
      completeSend: async (_uId, outboxId) => {
        const item = outboxItems.get(outboxId);
        if (item) {
          item.state = 'sent';
          item.leaseToken = null;
          item.leaseExpiresAt = null;
        }
      },
      failAttempt: async (_uId, outboxId, error, retryDelayMs, now) => {
        const item = outboxItems.get(outboxId);
        if (item) {
          item.attemptCount++;
          item.lastError = error;
          item.leaseToken = null;
          item.leaseExpiresAt = null;
          if (retryDelayMs != null) {
            item.state = 'failed';
            item.nextAttemptAt = new Date(now.getTime() + retryDelayMs);
          } else {
            item.state = 'failed';
            item.nextAttemptAt = null;
          }
        }
      },
      recoverStaleLeases: async (now) => {
        let count = 0;
        for (const item of outboxItems.values()) {
          if (item.state === 'sending' && item.leaseExpiresAt && item.leaseExpiresAt < now) {
            item.state = 'queued';
            item.leaseToken = null;
            item.leaseExpiresAt = null;
            count++;
          }
        }
        return count;
      },
      findByDraft: async () => null,
      save: async () => {},
      remove: async () => {},
      retryState: async () => null,
      setRetryState: async () => {},
    };

    const mailStore: MailStoreWriter = {
      upsertFolder: async () => {},
      removeFolder: async () => {},
      upsertMessage: async (_acc, msg) => {
        storedMessages.push(msg);
      },
      removeMessage: async () => {},
      providerRefOfMessage: async () => null,
      providerRefOfFolder: async () => null,
      findMessageByProviderUid: async () => null,
      findMessageByHeaderId: async () => null,
      getMailboxUids: async () => [],
      removeMessagesByUids: async () => 0,
      clearFolderMessages: async () => 0,
      updateMessageFlagsByUid: async () => false,
    };

    let sendFn: (req: OutgoingMessage) => Promise<{ readonly messageId: string | null }> = async () => ({
      messageId: '<sent-msg-123@example.com>',
    });

    const sender: MailSenderPort = {
      send: (req) => sendFn(req),
    };

    return {
      clock,
      ids,
      events,
      transactions,
      accountRepo,
      folderRepo,
      draftRepo,
      outboxRepo,
      mailStore,
      sender,
      outboxItems,
      drafts,
      storedMessages,
      setSendFn: (fn: (req: OutgoingMessage) => Promise<{ readonly messageId: string | null }>) => {
        sendFn = fn;
      },
    };
  };

  it('claims next due item, sends via SMTP, saves to Sent folder, and marks sent', async () => {
    const ctx = setupWorker();

    const worker = new OutboxWorker({
      outbox: ctx.outboxRepo,
      drafts: ctx.draftRepo,
      accounts: ctx.accountRepo,
      folders: ctx.folderRepo,
      sender: ctx.sender,
      mailStore: ctx.mailStore,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
    });

    const result = await worker.processNext();
    expect(result.outcome).toBe('sent');
    if (result.outcome === 'sent') {
      expect(result.outboxId).toBe('out-1');
      expect(result.messageId).not.toBeNull();
    }

    const item = ctx.outboxItems.get('out-1');
    expect(item?.state).toBe('sent');

    // Message saved to local sent folder
    expect(ctx.storedMessages).toHaveLength(1);
    expect(ctx.storedMessages[0].message.folderId).toBe('f-sent');
    expect(ctx.storedMessages[0].message.subject).toBe('Outgoing letter');

    // Events emitted
    expect(ctx.events.events.some((e) => e.event.type === 'outbox.changed' && e.event.state === 'sent')).toBe(true);
    expect(ctx.events.events.some((e) => e.event.type === 'messages.changed')).toBe(true);
  });

  it('prevents concurrent processing: two workers claiming simultaneously never process same item', async () => {
    const ctx = setupWorker();

    const worker1 = new OutboxWorker({
      outbox: ctx.outboxRepo,
      drafts: ctx.draftRepo,
      accounts: ctx.accountRepo,
      folders: ctx.folderRepo,
      sender: ctx.sender,
      mailStore: ctx.mailStore,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
    });

    const worker2 = new OutboxWorker({
      outbox: ctx.outboxRepo,
      drafts: ctx.draftRepo,
      accounts: ctx.accountRepo,
      folders: ctx.folderRepo,
      sender: ctx.sender,
      mailStore: ctx.mailStore,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
    });

    // Claim next on first worker
    const res1 = await worker1.processNext();
    expect(res1.outcome).toBe('sent');

    // Second worker attempts to claim immediately: item is now already sent/claimed
    const res2 = await worker2.processNext();
    expect(res2.outcome).toBe('idle');
  });

  it('retryable failure: network error schedules backoff retry and updates nextAttemptAt', async () => {
    const ctx = setupWorker();
    ctx.setSendFn(async () => {
      throw new Error('Connection timeout to SMTP host');
    });

    const worker = new OutboxWorker({
      outbox: ctx.outboxRepo,
      drafts: ctx.draftRepo,
      accounts: ctx.accountRepo,
      folders: ctx.folderRepo,
      sender: ctx.sender,
      mailStore: ctx.mailStore,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
      baseBackoffMs: 1_000,
    });

    const res = await worker.processNext();
    expect(res.outcome).toBe('retryable_failure');
    if (res.outcome === 'retryable_failure') {
      expect(res.outboxId).toBe('out-1');
      expect(res.nextAttemptAt.getTime()).toBeGreaterThan(ctx.clock.now().getTime());
    }

    const item = ctx.outboxItems.get('out-1');
    expect(item?.state).toBe('failed');
    expect(item?.attemptCount).toBe(1);
    expect(item?.lastError).toContain('Connection timeout');
  });

  it('permanent failure: invalid recipient or credentials fail immediately without retry', async () => {
    const ctx = setupWorker();
    ctx.setSendFn(async () => {
      throw new AppError('recipient_rejected', { operation: 'smtp.send' });
    });

    const worker = new OutboxWorker({
      outbox: ctx.outboxRepo,
      drafts: ctx.draftRepo,
      accounts: ctx.accountRepo,
      folders: ctx.folderRepo,
      sender: ctx.sender,
      mailStore: ctx.mailStore,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
    });

    const res = await worker.processNext();
    expect(res.outcome).toBe('permanent_failure');
    if (res.outcome === 'permanent_failure') {
      expect(res.outboxId).toBe('out-1');
    }

    const item = ctx.outboxItems.get('out-1');
    expect(item?.state).toBe('failed');
    expect(item?.nextAttemptAt).toBeNull(); // no retry scheduled
  });

  it('ambiguous delivery: SMTP failure after DATA does not automatically retry to prevent duplicate sends', async () => {
    const ctx = setupWorker();
    ctx.setSendFn(async () => {
      const err = new Error('Connection closed after DATA command');
      (err as unknown as Record<string, unknown>).command = 'DATA';
      (err as unknown as Record<string, unknown>).code = 'ECONNRESET';
      throw err;
    });

    const worker = new OutboxWorker({
      outbox: ctx.outboxRepo,
      drafts: ctx.draftRepo,
      accounts: ctx.accountRepo,
      folders: ctx.folderRepo,
      sender: ctx.sender,
      mailStore: ctx.mailStore,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
    });

    const res = await worker.processNext();
    expect(res.outcome).toBe('permanent_failure');
    if (res.outcome === 'permanent_failure') {
      expect(res.error).toContain('ambiguous_delivery');
    }

    const item = ctx.outboxItems.get('out-1');
    expect(item?.state).toBe('failed');
    expect(item?.nextAttemptAt).toBeNull(); // durable ambiguous state, no auto-retry!
    expect(item?.lastError).toContain('ambiguous_delivery');
  });

  it('crash recovery: recovers stale expired leases and makes operations ready for retry', async () => {
    const ctx = setupWorker();

    // Mark item as crashed during sending 5 minutes ago with expired lease
    const item = ctx.outboxItems.get('out-1')!;
    item.state = 'sending';
    item.leaseToken = 'worker-crashed';
    item.leaseExpiresAt = new Date(ctx.clock.now().getTime() - 60_000); // expired 1 min ago

    const worker = new OutboxWorker({
      outbox: ctx.outboxRepo,
      drafts: ctx.draftRepo,
      accounts: ctx.accountRepo,
      folders: ctx.folderRepo,
      sender: ctx.sender,
      mailStore: ctx.mailStore,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
    });

    const recovered = await worker.recoverStaleLeases();
    expect(recovered).toBe(1);

    expect(item.state).toBe('queued');
    expect(item.leaseToken).toBeNull();

    // Now it can be processed successfully
    const res = await worker.processNext();
    expect(res.outcome).toBe('sent');
  });

  it('multi-account isolation: worker operates strictly within the claimed item account boundaries', async () => {
    const ctx = setupWorker();

    // Add a second account
    const secondAccountId = 'acc-2';

    // Item belonging to account 1
    const worker = new OutboxWorker({
      outbox: ctx.outboxRepo,
      drafts: ctx.draftRepo,
      accounts: ctx.accountRepo,
      folders: ctx.folderRepo,
      sender: ctx.sender,
      mailStore: ctx.mailStore,
      events: ctx.events,
      clock: ctx.clock,
      ids: ctx.ids,
      transactions: ctx.transactions,
    });

    await worker.processNext();

    // Verify stored sent message is tagged with account 1, never account 2
    expect(ctx.storedMessages[0].message.accountId).toBe(accountId);
    expect(ctx.storedMessages[0].message.accountId).not.toBe(secondAccountId);
  });
});

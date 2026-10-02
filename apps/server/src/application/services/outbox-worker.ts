import type { DraftDTO, MessageDTO } from '@kaydet/domain';
import { grantAccountAccess } from '../context/authorized-account.ts';
import { isAppError } from '../errors.ts';
import type { Clock } from '../ports/clock/clock.ts';
import type { EventBus } from '../ports/events/event-bus.ts';
import type { IdGenerator } from '../ports/ids/id-generator.ts';
import type { MailSenderPort } from '../ports/mail/sender.ts';
import type { AccountRepository } from '../ports/repositories/account-repository.ts';
import type { ClaimedOutboxItem, DraftRepository, OutboxRepository } from '../ports/repositories/draft-repository.ts';
import type { FolderRepository } from '../ports/repositories/folder-repository.ts';
import type { MailStoreWriter, StoredMessage } from '../ports/repositories/mail-store.ts';
import type { UnitOfWork } from '../ports/transaction/unit-of-work.ts';

export interface OutboxWorkerOptions {
  readonly outbox: OutboxRepository;
  readonly drafts: DraftRepository;
  readonly accounts: AccountRepository;
  readonly folders: FolderRepository;
  readonly sender: MailSenderPort;
  readonly mailStore: MailStoreWriter;
  readonly events: EventBus;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly transactions: UnitOfWork;
  readonly maxRetries?: number;
  readonly leaseDurationMs?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

export type OutboxProcessResult =
  | { readonly outcome: 'sent'; readonly outboxId: string; readonly messageId: string | null }
  | { readonly outcome: 'retryable_failure'; readonly outboxId: string; readonly error: string; readonly nextAttemptAt: Date }
  | { readonly outcome: 'permanent_failure'; readonly outboxId: string; readonly error: string }
  | { readonly outcome: 'idle' };

export class OutboxWorker {
  private readonly outbox: OutboxRepository;
  private readonly drafts: DraftRepository;
  private readonly accounts: AccountRepository;
  private readonly folders: FolderRepository;
  private readonly sender: MailSenderPort;
  private readonly mailStore: MailStoreWriter;
  private readonly events: EventBus;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly transactions: UnitOfWork;
  private readonly maxRetries: number;
  private readonly leaseDurationMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(options: OutboxWorkerOptions) {
    this.outbox = options.outbox;
    this.drafts = options.drafts;
    this.accounts = options.accounts;
    this.folders = options.folders;
    this.sender = options.sender;
    this.mailStore = options.mailStore;
    this.events = options.events;
    this.clock = options.clock;
    this.ids = options.ids;
    this.transactions = options.transactions;
    this.maxRetries = options.maxRetries ?? 5;
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.baseBackoffMs = options.baseBackoffMs ?? 2_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 300_000;
  }

  /**
   * Recovers any operations stuck in 'sending' whose lease has expired.
   */
  async recoverStaleLeases(): Promise<number> {
    return await this.outbox.recoverStaleLeases(this.clock.now());
  }

  /**
   * Processes a single ready outbox operation.
   * Atomic claiming prevents duplicate execution across multiple workers.
   */
  async processNext(): Promise<OutboxProcessResult> {
    const workerToken = this.ids.next();
    const now = this.clock.now();

    // 1. Atomically claim next due item
    const claimed = await this.outbox.claimNextDue(workerToken, this.leaseDurationMs, now);
    if (!claimed) {
      return { outcome: 'idle' };
    }

    return await this.executeClaimed(claimed);
  }

  /**
   * Drains the queue until no more items are due or maxItems limit is reached.
   */
  async processBatch(maxItems = 10): Promise<readonly OutboxProcessResult[]> {
    const results: OutboxProcessResult[] = [];
    for (let i = 0; i < maxItems; i++) {
      const res = await this.processNext();
      if (res.outcome === 'idle') break;
      results.push(res);
    }
    return results;
  }

  private async executeClaimed(claimed: ClaimedOutboxItem): Promise<OutboxProcessResult> {
    const now = this.clock.now();

    // 2. Resolve account
    const accountDto = await this.accounts.findOwned(claimed.userId, claimed.accountId);
    if (!accountDto) {
      const err = 'account_not_found';
      await this.outbox.failAttempt(claimed.userId, claimed.outboxId, err, null, now);
      this.events.publish(claimed.userId, {
        type: 'outbox.changed',
        accountId: claimed.accountId,
        outboxId: claimed.outboxId,
        draftId: claimed.draftId,
        state: 'failed',
      });
      return { outcome: 'permanent_failure', outboxId: claimed.outboxId, error: err };
    }

    const authorizedAccount = grantAccountAccess({ ...accountDto, userId: claimed.userId });

    // 3. Resolve draft
    const draft = await this.drafts.find(claimed.userId, claimed.draftId);
    if (!draft) {
      const err = 'draft_not_found';
      await this.outbox.failAttempt(claimed.userId, claimed.outboxId, err, null, now);
      this.events.publish(claimed.userId, {
        type: 'outbox.changed',
        accountId: claimed.accountId,
        outboxId: claimed.outboxId,
        draftId: claimed.draftId,
        state: 'failed',
      });
      return { outcome: 'permanent_failure', outboxId: claimed.outboxId, error: err };
    }

    // 4. Send via MailSenderPort (SMTP)
    try {
      const sendResult = await this.sender.send({
        account: authorizedAccount,
        draft,
      });

      // 5. Success handling: store sent message in Sent folder and complete outbox item
      const sentMessageId = await this.recordSentMessage(authorizedAccount, draft, sendResult.messageId);

      await this.outbox.completeSend(claimed.userId, claimed.outboxId, sentMessageId, this.clock.now());

      this.events.publish(claimed.userId, {
        type: 'outbox.changed',
        accountId: claimed.accountId,
        outboxId: claimed.outboxId,
        draftId: claimed.draftId,
        state: 'sent',
      });

      return {
        outcome: 'sent',
        outboxId: claimed.outboxId,
        messageId: sentMessageId,
      };
    } catch (error) {
      return await this.handleSendError(claimed, error);
    }
  }

  private async recordSentMessage(
    account: ReturnType<typeof grantAccountAccess>,
    draft: DraftDTO,
    messageIdHeader: string | null,
  ): Promise<string | null> {
    const folders = await this.folders.listByAccount(account);
    const sentFolder = folders.find((f) => f.role === 'sent') ?? folders[0];
    if (!sentFolder) return null;

    const messageId = this.ids.next();
    const threadId = draft.source?.messageId ?? this.ids.next();
    const nowIso = this.clock.now().toISOString();

    const messageDto: MessageDTO = {
      id: messageId,
      accountId: account.id,
      folderId: sentFolder.id,
      threadId,
      from: { email: account.email, name: '' },
      to: [...draft.to],
      cc: [...draft.cc],
      bcc: [...draft.bcc],
      subject: draft.subject,
      preview: draft.bodyText.slice(0, 200),
      date: nowIso,
      seen: true,
      pinned: false,
      answered: false,
      forwarded: false,
      draft: false,
      hasAttachments: draft.attachments.length > 0,
      labels: [],
      outbox: {
        state: 'sent',
      },
      body: {
        text: draft.bodyText,
        html: draft.bodyHtml ? { content: draft.bodyHtml, sanitized: true } : null,
      },
      attachments: [...draft.attachments],
    };

    const stored: StoredMessage = {
      message: messageDto,
      provider: {
        uid: null,
        uidValidity: null,
        modSeq: null,
        messageIdHeader,
        inReplyTo: draft.source?.messageId ?? null,
        references: draft.source?.messageId ?? null,
      },
    };

    await this.transactions.run(async () => {
      await this.mailStore.upsertMessage(account, stored);
    });

    this.events.publish(account.userId, {
      type: 'messages.changed',
      accountId: account.id,
      folderIds: [sentFolder.id],
    });

    return messageId;
  }

  private async handleSendError(claimed: ClaimedOutboxItem, error: unknown): Promise<OutboxProcessResult> {
    const now = this.clock.now();
    const isAmbiguous = this.isAmbiguousSmtpError(error);
    const isPermanent = isAmbiguous || this.isPermanentError(error);
    const attempt = claimed.attemptCount + 1;
    const errorMessage = isAmbiguous
      ? 'ambiguous_delivery: delivery outcome could not be confirmed'
      : (error instanceof Error ? error.message : 'Send failed');

    if (isPermanent || attempt >= this.maxRetries) {
      // Pass null retryDelayMs so nextAttemptAt is null - never automatically retried
      await this.outbox.failAttempt(claimed.userId, claimed.outboxId, errorMessage, null, now);

      this.events.publish(claimed.userId, {
        type: 'outbox.changed',
        accountId: claimed.accountId,
        outboxId: claimed.outboxId,
        draftId: claimed.draftId,
        state: 'failed',
      });

      return {
        outcome: 'permanent_failure',
        outboxId: claimed.outboxId,
        error: errorMessage,
      };
    }

    // Exponential backoff with jitter
    const backoff = Math.min(this.maxBackoffMs, this.baseBackoffMs * Math.pow(2, claimed.attemptCount));
    const jitter = Math.floor(Math.random() * 500);
    const delayMs = backoff + jitter;
    const nextAttemptAt = new Date(now.getTime() + delayMs);

    await this.outbox.failAttempt(claimed.userId, claimed.outboxId, errorMessage, delayMs, now);

    this.events.publish(claimed.userId, {
      type: 'outbox.changed',
      accountId: claimed.accountId,
      outboxId: claimed.outboxId,
      draftId: claimed.draftId,
      state: 'failed',
    });

    return {
      outcome: 'retryable_failure',
      outboxId: claimed.outboxId,
      error: errorMessage,
      nextAttemptAt,
    };
  }

  private isAmbiguousSmtpError(error: unknown): boolean {
    if (!error) return false;
    if (typeof error === 'object') {
      const err = error as Record<string, unknown>;
      if (err.isAmbiguous === true) return true;
      if (err.cause && typeof err.cause === 'object' && (err.cause as Record<string, unknown>).isAmbiguous === true) {
        return true;
      }
      const msg = typeof err.message === 'string' ? err.message : '';
      if (msg.includes('ambiguous_delivery') || msg.toLowerCase().includes('delivery outcome unknown')) {
        return true;
      }
      const cmd = typeof err.command === 'string' ? err.command.toUpperCase() : '';
      const code = typeof err.code === 'string' ? err.code.toUpperCase() : '';
      if (
        (cmd === 'DATA' || cmd === 'END DATA' || msg.toUpperCase().includes('AFTER DATA') || msg.toUpperCase().includes('DURING DATA')) &&
        (code === 'ETIMEDOUT' ||
          code === 'ECONNRESET' ||
          code === 'EPIPE' ||
          code === 'ESOCKET' ||
          msg.toLowerCase().includes('timeout') ||
          msg.toLowerCase().includes('connection closed') ||
          msg.toLowerCase().includes('socket closed'))
      ) {
        return true;
      }
    }
    return false;
  }

  private isPermanentError(error: unknown): boolean {
    if (isAppError(error)) {
      switch (error.code) {
        case 'recipient_rejected':
        case 'invalid_recipient':
        case 'mail_credentials_rejected':
        case 'draft_not_found':
        case 'account_not_found':
        case 'no_recipients':
          return true;
        default:
          return false;
      }
    }
    return false;
  }
}

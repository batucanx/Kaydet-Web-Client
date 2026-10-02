import { applyMessageFilter, foldForSearch, matchesSearchFilters, tokenizeSearchQuery } from '@kaydet/domain';
import type { AccountDTO, DraftDTO, FolderDTO, LabelDTO, MessageDTO, MessageSummaryDTO, OutboxDTO, SearchResultDTO, SignatureDTO, TemplateDTO } from '@kaydet/domain';
import { AppError } from '../../application/index.ts';
import type {
  AccountRepository,
  AuthorizedAccount,
  ClaimedOutboxItem,
  DraftRepository,
  FolderRepository,
  LabelRepository,
  MessageListQuery,
  MessageLocation,
  MessageRepository,
  MessageSearchQuery,
  OutboxRepository,
  OutboxRetryState,
  PageRequest,
  RepositoryPage,
  SignatureRepository,
  TemplateRepository,
} from '../../application/index.ts';
import type { MemoryStore } from './memory-store.ts';
import { scoped } from './memory-store.ts';

export class MemoryAccountRepository implements AccountRepository {
  constructor(private readonly store: MemoryStore) {}

  listByUser(userId: string): Promise<AccountDTO[]> {
    return Promise.resolve(this.store.accounts.filter((a) => a.userId === userId).map((a) => a.account));
  }

  findOwned(userId: string, accountId: string): Promise<AccountDTO | null> {
    return Promise.resolve(this.store.accounts.find((a) => a.userId === userId && a.account.id === accountId)?.account ?? null);
  }

  create(userId: string, account: AccountDTO): Promise<void> {
    this.store.accounts.push({ userId, account });
    return Promise.resolve();
  }

  update(account: AuthorizedAccount, patch: { readonly displayName?: string }): Promise<AccountDTO> {
    const entry = this.store.accounts.find((a) => a.userId === account.userId && a.account.id === account.id);
    if (entry === undefined) return Promise.reject(new Error('account vanished'));
    entry.account = { ...entry.account, ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }) };
    return Promise.resolve(entry.account);
  }

  remove(account: AuthorizedAccount): Promise<void> {
    const at = this.store.accounts.findIndex((a) => a.userId === account.userId && a.account.id === account.id);
    if (at >= 0) this.store.accounts.splice(at, 1);
    return Promise.resolve();
  }
}

export class MemoryFolderRepository implements FolderRepository {
  constructor(private readonly store: MemoryStore) {}

  listByAccount(account: AuthorizedAccount): Promise<FolderDTO[]> {
    return Promise.resolve(this.store.folders.filter((f) => f.accountId === account.id));
  }

  find(account: AuthorizedAccount, folderId: string): Promise<FolderDTO | null> {
    return Promise.resolve(this.store.folders.find((f) => f.accountId === account.id && f.id === folderId) ?? null);
  }
}

/** Offset position as text; anything else is a forged/garbled cursor. (A SQL adapter would use a keyset.) */
function offsetOf(page: PageRequest): number {
  if (page.position === null) return 0;
  if (!/^\d{1,9}$/.test(page.position)) throw new AppError('invalid_cursor');
  return Number(page.position);
}

function slice<T>(all: readonly T[], page: PageRequest): RepositoryPage<T> {
  const start = offsetOf(page);
  const items = all.slice(start, start + page.limit);
  return { items, nextPosition: start + page.limit < all.length ? String(start + page.limit) : null };
}

function toSummary(message: MessageDTO): MessageSummaryDTO {
  const { cc: _cc, bcc: _bcc, body: _body, attachments: _attachments, ...summary } = message;
  return summary;
}

/**
 * Test/dev read model. Its search is a plain substring match over subject/sender/recipients/preview — enough to
 * exercise the contract, NOT a search engine (real search/FTS is a later phase).
 */
export class MemoryMessageRepository implements MessageRepository {
  constructor(private readonly store: MemoryStore) {}

  findOwned(userId: string, messageId: string): Promise<MessageDTO | null> {
    const message = this.store.messages.find((m) => m.id === messageId);
    return Promise.resolve(message !== undefined && this.store.ownerOf(message.accountId) === userId ? message : null);
  }

  locateOwned(userId: string, messageIds: readonly string[]): Promise<Map<string, MessageLocation>> {
    const found = new Map<string, MessageLocation>();
    for (const id of messageIds) {
      const message = this.store.messages.find((m) => m.id === id);
      if (message === undefined || this.store.ownerOf(message.accountId) !== userId) continue;
      const folder = this.store.folders.find((f) => f.id === message.folderId);
      found.set(id, { accountId: message.accountId, folderId: message.folderId, folderRole: folder?.role ?? 'custom', draft: message.draft });
    }
    return Promise.resolve(found);
  }

  listPage(account: AuthorizedAccount, query: MessageListQuery): Promise<RepositoryPage<MessageSummaryDTO>> {
    const inScope = this.store.messages.filter(
      (m) => m.accountId === account.id && (query.scope.kind === 'pinned' ? m.pinned : m.folderId === query.scope.folderId),
    );
    return Promise.resolve(slice(applyMessageFilter(inScope, query.filter).map(toSummary), query.page));
  }

  search(accounts: readonly AuthorizedAccount[], query: MessageSearchQuery): Promise<RepositoryPage<SearchResultDTO>> {
    const ids = new Set(accounts.map((a) => a.id));
    const tokens = tokenizeSearchQuery(query.q).map(foldForSearch);
    const after = query.dateRange?.after === undefined ? -Infinity : Date.parse(query.dateRange.after);
    const before = query.dateRange?.before === undefined ? Infinity : Date.parse(query.dateRange.before);

    const hits: SearchResultDTO[] = [];
    for (const m of this.store.messages) {
      const folder = this.store.folders.find((f) => f.id === m.folderId);
      if (!ids.has(m.accountId) || folder === undefined) continue;
      const time = Date.parse(m.date);
      if (time < after || time >= before) continue;
      const searchable = { hasAttachments: m.hasAttachments, flaggedDeleted: false, folderRole: folder.role, folderName: folder.name };
      if (!matchesSearchFilters(searchable, query.filters)) continue;
      const haystack = foldForSearch([m.subject, m.from.name, m.from.email, m.preview, ...m.to.map((a) => `${a.name} ${a.email}`)].join(' '));
      if (tokens.every((t) => haystack.includes(t))) {
        hits.push({ message: toSummary(m), folder: { id: folder.id, name: folder.name, role: folder.role } });
      }
    }
    hits.sort((a, b) => Date.parse(b.message.date) - Date.parse(a.message.date));
    return Promise.resolve(slice(hits, query.page));
  }
}

export class MemoryDraftRepository implements DraftRepository {
  constructor(private readonly store: MemoryStore) {}

  find(userId: string, draftId: string): Promise<DraftDTO | null> {
    return Promise.resolve(this.store.drafts.get(scoped(userId, draftId)) ?? null);
  }
  save(userId: string, draft: DraftDTO): Promise<void> {
    this.store.drafts.set(scoped(userId, draft.id), draft);
    return Promise.resolve();
  }
  remove(userId: string, draftId: string): Promise<void> {
    this.store.drafts.delete(scoped(userId, draftId));
    return Promise.resolve();
  }
}

export class MemoryOutboxRepository implements OutboxRepository {
  constructor(private readonly store: MemoryStore) {}

  find(userId: string, outboxId: string): Promise<OutboxDTO | null> {
    return Promise.resolve(this.store.outbox.find((o) => o.userId === userId && o.outbox.id === outboxId)?.outbox ?? null);
  }
  findByDraft(userId: string, draftId: string): Promise<OutboxDTO | null> {
    const own = this.store.outbox.filter((o) => o.userId === userId && o.outbox.draftId === draftId);
    return Promise.resolve(own.at(-1)?.outbox ?? null);
  }
  save(userId: string, outbox: OutboxDTO): Promise<void> {
    const at = this.store.outbox.findIndex((o) => o.userId === userId && o.outbox.id === outbox.id);
    if (at >= 0) this.store.outbox[at] = { userId, outbox };
    else this.store.outbox.push({ userId, outbox });
    return Promise.resolve();
  }
  remove(userId: string, outboxId: string): Promise<void> {
    const at = this.store.outbox.findIndex((o) => o.userId === userId && o.outbox.id === outboxId);
    if (at >= 0) this.store.outbox.splice(at, 1);
    this.retry.delete(`${userId}|${outboxId}`);
    return Promise.resolve();
  }

  private readonly retry = new Map<string, OutboxRetryState>();

  retryState(userId: string, outboxId: string): Promise<OutboxRetryState | null> {
    if (!this.store.outbox.some((o) => o.userId === userId && o.outbox.id === outboxId)) return Promise.resolve(null);
    return Promise.resolve(this.retry.get(`${userId}|${outboxId}`) ?? { attemptCount: 0, nextAttemptAt: null });
  }

  setRetryState(userId: string, outboxId: string, state: OutboxRetryState): Promise<void> {
    this.retry.set(`${userId}|${outboxId}`, state);
    return Promise.resolve();
  }

  private readonly leases = new Map<string, { token: string; expiresAt: Date }>();

  async claimNextDue(workerToken: string, leaseDurationMs: number, now: Date): Promise<ClaimedOutboxItem | null> {
    for (const item of this.store.outbox) {
      const o = item.outbox;
      const retry = this.retry.get(`${item.userId}|${o.id}`) ?? { attemptCount: 0, nextAttemptAt: null };
      const lease = this.leases.get(o.id);
      const isLeaseExpired = !lease || lease.expiresAt <= now;

      const isQueuedReady = o.state === 'queued' && (!o.cancellableUntil || new Date(o.cancellableUntil) <= now);
      const isFailedReady = o.state === 'failed' && retry.nextAttemptAt !== null && retry.nextAttemptAt <= now;
      const isSendingStale = o.state === 'sending' && isLeaseExpired;

      if ((isQueuedReady || isFailedReady || isSendingStale) && isLeaseExpired) {
        o.state = 'sending';
        this.leases.set(o.id, { token: workerToken, expiresAt: new Date(now.getTime() + leaseDurationMs) });
        return {
          outboxId: o.id,
          userId: item.userId,
          accountId: o.accountId,
          draftId: o.draftId,
          attemptCount: retry.attemptCount,
        };
      }
    }
    return null;
  }

  async completeSend(userId: string, outboxId: string, messageId: string | null, _now: Date): Promise<void> {
    const item = this.store.outbox.find((o) => o.userId === userId && o.outbox.id === outboxId);
    if (item) {
      item.outbox.state = 'sent';
      item.outbox.messageId = messageId;
      item.outbox.error = null;
      this.leases.delete(outboxId);
    }
  }

  async failAttempt(userId: string, outboxId: string, error: string, retryDelayMs: number | null, now: Date): Promise<void> {
    const item = this.store.outbox.find((o) => o.userId === userId && o.outbox.id === outboxId);
    if (item) {
      item.outbox.state = 'failed';
      item.outbox.error = error;
      const currentRetry = this.retry.get(`${userId}|${outboxId}`) ?? { attemptCount: 0, nextAttemptAt: null };
      this.retry.set(`${userId}|${outboxId}`, {
        attemptCount: currentRetry.attemptCount + 1,
        nextAttemptAt: retryDelayMs !== null ? new Date(now.getTime() + retryDelayMs) : null,
      });
      this.leases.delete(outboxId);
    }
  }

  async recoverStaleLeases(now: Date): Promise<number> {
    let recovered = 0;
    for (const item of this.store.outbox) {
      if (item.outbox.state === 'sending') {
        const lease = this.leases.get(item.outbox.id);
        if (!lease || lease.expiresAt <= now) {
          item.outbox.state = 'queued';
          this.leases.delete(item.outbox.id);
          recovered++;
        }
      }
    }
    return recovered;
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): void {
  const at = list.findIndex((x) => x.id === item.id);
  if (at >= 0) list[at] = item;
  else list.push(item);
}

export class MemoryLabelRepository implements LabelRepository {
  constructor(private readonly store: MemoryStore) {}

  list(account: AuthorizedAccount): Promise<LabelDTO[]> {
    return Promise.resolve(this.store.labels.filter((l) => l.accountId === account.id));
  }
  find(account: AuthorizedAccount, labelId: string): Promise<LabelDTO | null> {
    return Promise.resolve(this.store.labels.find((l) => l.accountId === account.id && l.id === labelId) ?? null);
  }
  save(account: AuthorizedAccount, label: LabelDTO): Promise<void> {
    upsert(this.store.labels, { ...label, accountId: account.id });
    return Promise.resolve();
  }
  remove(account: AuthorizedAccount, labelId: string): Promise<void> {
    const at = this.store.labels.findIndex((l) => l.accountId === account.id && l.id === labelId);
    if (at >= 0) this.store.labels.splice(at, 1);
    return Promise.resolve();
  }
}

export class MemorySignatureRepository implements SignatureRepository {
  constructor(private readonly store: MemoryStore) {}

  list(account: AuthorizedAccount): Promise<SignatureDTO[]> {
    return Promise.resolve(this.store.signatures.filter((s) => s.accountId === account.id));
  }
  find(account: AuthorizedAccount, signatureId: string): Promise<SignatureDTO | null> {
    return Promise.resolve(this.store.signatures.find((s) => s.accountId === account.id && s.id === signatureId) ?? null);
  }
  save(account: AuthorizedAccount, signature: SignatureDTO): Promise<void> {
    upsert(this.store.signatures, { ...signature, accountId: account.id });
    return Promise.resolve();
  }
  remove(account: AuthorizedAccount, signatureId: string): Promise<void> {
    const at = this.store.signatures.findIndex((s) => s.accountId === account.id && s.id === signatureId);
    if (at >= 0) this.store.signatures.splice(at, 1);
    return Promise.resolve();
  }
}

export class MemoryTemplateRepository implements TemplateRepository {
  constructor(private readonly store: MemoryStore) {}

  list(userId: string): Promise<TemplateDTO[]> {
    return Promise.resolve(this.store.templates.filter((t) => t.userId === userId).map((t) => t.template));
  }
  find(userId: string, templateId: string): Promise<TemplateDTO | null> {
    return Promise.resolve(this.store.templates.find((t) => t.userId === userId && t.template.id === templateId)?.template ?? null);
  }
  save(userId: string, template: TemplateDTO): Promise<void> {
    const at = this.store.templates.findIndex((t) => t.userId === userId && t.template.id === template.id);
    if (at >= 0) this.store.templates[at] = { userId, template };
    else this.store.templates.push({ userId, template });
    return Promise.resolve();
  }
  remove(userId: string, templateId: string): Promise<void> {
    const at = this.store.templates.findIndex((t) => t.userId === userId && t.template.id === templateId);
    if (at >= 0) this.store.templates.splice(at, 1);
    return Promise.resolve();
  }
}

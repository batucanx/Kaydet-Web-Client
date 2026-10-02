import type {
  AccountDTO,
  DraftDTO,
  FolderDTO,
  LabelDTO,
  MessageDTO,
  OutboxDTO,
  SignatureDTO,
  TemplateDTO,
} from '@kaydet/domain';

/**
 * The state behind every in-memory repository. NON-DURABLE: it lives and dies with the process. It exists so the
 * server foundation can be exercised end to end without SQLite; tests seed it directly.
 */
export class MemoryStore {
  readonly accounts: Array<{ userId: string; account: AccountDTO }> = [];
  readonly folders: FolderDTO[] = [];
  readonly messages: MessageDTO[] = [];
  readonly drafts = new Map<string, DraftDTO>();
  /** Insertion order = creation order (`findByDraft` returns the latest). */
  readonly outbox: Array<{ userId: string; outbox: OutboxDTO }> = [];
  readonly labels: LabelDTO[] = [];
  readonly signatures: SignatureDTO[] = [];
  readonly templates: Array<{ userId: string; template: TemplateDTO }> = [];

  /** Owner of an account id, or `null`. */
  ownerOf(accountId: string): string | null {
    return this.accounts.find((a) => a.account.id === accountId)?.userId ?? null;
  }
}

/** Per-user namespace for client-generated ids. */
export const scoped = (userId: string, id: string): string => `${userId}|${id}`;

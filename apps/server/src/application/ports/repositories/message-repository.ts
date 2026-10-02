import type {
  DateRange,
  FolderRole,
  MessageDTO,
  MessageFilter,
  MessageScope,
  MessageSummaryDTO,
  SearchFilters,
  SearchResultDTO,
} from '@kaydet/domain';
import type { AuthorizedAccount } from '../../context/authorized-account.ts';
import type { PageRequest, RepositoryPage } from '../../pagination.ts';

export interface MessageListQuery {
  readonly scope: MessageScope;
  readonly filter: MessageFilter;
  readonly page: PageRequest;
}

export interface MessageSearchQuery {
  readonly q: string;
  readonly filters: SearchFilters;
  readonly dateRange: DateRange | null;
  readonly page: PageRequest;
}

/** Where a message lives (used to authorise and validate actions on ids the client sent). */
export interface MessageLocation {
  readonly accountId: string;
  readonly folderId: string;
  readonly folderRole: FolderRole;
  readonly draft: boolean;
}

/**
 * Read model of messages (a synchronised local view — never the IMAP server). Message ids are only meaningful
 * inside their owner, so every lookup takes the user (`findOwned`, `locateOwned`) or an `AuthorizedAccount`.
 */
export interface MessageRepository {
  /** Full message incl. sanitised body; `null` when it does not exist for this user. */
  findOwned(userId: string, messageId: string): Promise<MessageDTO | null>;
  /** Locations of the given ids that belong to this user; ids that are unknown (or foreign) are simply absent. */
  locateOwned(userId: string, messageIds: readonly string[]): Promise<Map<string, MessageLocation>>;
  listPage(account: AuthorizedAccount, query: MessageListQuery): Promise<RepositoryPage<MessageSummaryDTO>>;
  /** Search within exactly these (already authorised) accounts. */
  search(accounts: readonly AuthorizedAccount[], query: MessageSearchQuery): Promise<RepositoryPage<SearchResultDTO>>;
}

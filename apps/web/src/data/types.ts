/**
 * The data port the shell is built against, plus the UI-only types around it.
 *
 * The data itself is described by the shared API contract (`@kaydet/domain`): the names below are
 * the UI's short aliases for the browser-safe DTOs (no UIDs, no protocol fields, no credentials;
 * Kaydet terminology — `pinned` = IMAP \Flagged = "Sabitle"). Only what the contract does not
 * define stays here: the virtual pinned folder id used in URL state, loading states, paging
 * handles and the action/undo port.
 *
 * Today `MailDataSource` is implemented by a mock (`data/mock`); later by an API-backed source
 * built on the contract's route table. Nothing outside `data/mock` (enforced by ESLint) may
 * import mock data.
 */
import { EMPTY_MESSAGE_FILTER, isFilterActive } from '@kaydet/domain';
import type {
  AccountDTO,
  EmailAddressDTO,
  FolderDTO,
  FolderRole,
  LabelDTO,
  MessageDTO,
  MessageFilter,
  MessageSort,
  MessageSummaryDTO,
  OutboxState,
} from '@kaydet/domain';

export type { FolderRole, MessageDTO, MessageSort, OutboxState };
export { isFilterActive };

/** The virtual "Sabitlenenler" folder — not a mailbox (mobile: `SelectedFolder.flagged()`). */
export const PINNED_FOLDER = 'pinned';

export type AccountView = AccountDTO;
export type FolderView = FolderDTO;
export type LabelView = LabelDTO;
export type Person = EmailAddressDTO;
export type MessageSummary = MessageSummaryDTO;

/** mobile: MessageFilter (independent toggles, not radio categories). */
export type MailFilter = MessageFilter;
export const EMPTY_FILTER: MailFilter = EMPTY_MESSAGE_FILTER;

export interface MessageQuery {
  accountId: string;
  /** Folder id or `PINNED_FOLDER`. */
  folder: string;
  filter: MailFilter;
}

export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T };

export interface MessagePage {
  items: MessageSummary[];
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}

/** mobile: MailActionHandle. `undo` resolves false when the action can no longer be reverted. */
export interface UndoHandle {
  undo: () => Promise<boolean>;
}

/** The action set supported by mobile business rules (no others). */
export interface MailActions {
  setSeen: (ids: string[], seen: boolean) => void;
  setPinned: (ids: string[], pinned: boolean) => void;
  archive: (ids: string[]) => UndoHandle | null;
  /** Move to Trash from a normal folder (undoable). */
  remove: (ids: string[]) => UndoHandle | null;
  /** Trash/Junk/Drafts only — irreversible; the caller must have confirmed. */
  deletePermanently: (ids: string[]) => void;
  /** mobile `restoreToInbox` (from Archive, Trash, Junk). */
  restoreToInbox: (ids: string[]) => UndoHandle | null;
  markSpam: (ids: string[]) => UndoHandle | null;
  moveToFolder: (ids: string[], folderId: string) => UndoHandle | null;
  applyLabel: (ids: string[], labelName: string) => void;
}

/**
 * The port. Members named `use*` are React hooks (stable identity per source). A real
 * implementation returns Query-backed data; the shell cannot tell the difference.
 */
export interface MailDataSource {
  useAccounts: () => Loadable<AccountView[]>;
  reloadAccounts?: () => Promise<void>;
  useFolders: (accountId: string) => Loadable<FolderView[]>;
  useLabels: (accountId: string) => Loadable<LabelView[]>;
  /** Count of pinned messages in an account (Sabitlenenler badge). */
  usePinnedCount: (accountId: string) => number;
  /** Pinned messages of an account, for the Inbox "Sabitlenenler" section. */
  usePinned: (accountId: string) => MessageSummary[];
  useMessages: (query: MessageQuery) => Loadable<MessagePage>;
  useMessageDetail: (accountId: string, messageId: string) => Loadable<MessageDTO>;
  actions: MailActions;
}

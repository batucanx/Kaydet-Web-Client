/**
 * Mailbox (IMAP-side) operations, in Kaydet terms.
 *
 * The application speaks application ids and contract types; the adapter maps them to whatever the provider
 * needs (paths, UIDs, UIDVALIDITY, MODSEQ, flags) and keeps all of that to itself. Failures are signalled with
 * `AppError` carrying a contract provider/sync code (`provider_unreachable`, `provider_rejected`,
 * `sync_failed_temporarily`, …) — never with raw provider text.
 *
 * Phase 3 defines the port only. The composition root binds an adapter that answers `service_unavailable`;
 * the real IMAP adapter is a later phase. Capabilities added when their use case exists (fetch body, search
 * against the server, save draft…) — not speculatively now.
 */
import type { ApiErrorCode, FolderCreateRequest, FolderDTO, FolderUpdateRequest, MessageAction, UndoInfo } from '@kaydet/domain';
import type { AuthorizedAccount } from '../../context/authorized-account.ts';

export interface MailActionRequest {
  readonly account: AuthorizedAccount;
  /** Already verified to belong to `account`. */
  readonly messageIds: readonly string[];
  readonly actions: readonly MessageAction[];
}

export interface MailActionResult {
  readonly appliedIds: readonly string[];
  readonly failed: ReadonlyArray<{ readonly messageId: string; readonly code: ApiErrorCode }>;
  /** Present only when the adapter made the operation undoable (decision D4). */
  readonly undo: UndoInfo | null;
  /** Folders whose contents changed (source and target of moves), for `messages.changed`. */
  readonly affectedFolderIds: readonly string[];
}

export type MailUndoResult =
  | { readonly restored: false }
  | { readonly restored: true; readonly accountId: string; readonly folderIds: readonly string[] };

export interface MailboxPort {
  /** Starts a synchronisation of the account now. Progress is reported as `sync.status` events. */
  requestSync(account: AuthorizedAccount): Promise<'started' | 'already_running'>;
  createFolder(account: AuthorizedAccount, request: FolderCreateRequest): Promise<FolderDTO>;
  updateFolder(account: AuthorizedAccount, folderId: string, patch: FolderUpdateRequest): Promise<FolderDTO>;
  deleteFolder(account: AuthorizedAccount, folderId: string): Promise<void>;
  applyActions(request: MailActionRequest): Promise<MailActionResult>;
  /** Undo is scoped to the user who performed the action; an unknown/expired/foreign token is `restored: false`. */
  undo(userId: string, token: string): Promise<MailUndoResult>;
}

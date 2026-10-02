/**
 * Delete semantics and undo timing.
 *
 * SOURCE: mobile `MailRepository.deleteMessages`/`deletePermanently`, `FolderMapping.deleteIsPermanent`,
 *         `confirmDelete` in `lib/ui/core/actions/message_actions.dart` (Drafts are permanent + confirmed),
 *         `mailUndoWindowProvider` (6 s server-side window) and `_undoNoticeDuration` (5 s toast) — the toast
 *         is shorter than the window so a visible "Geri al" is always still valid.
 * PURPOSE: Deleting in a normal folder MOVES to Trash and is undoable. Deleting in Trash and Junk is
 *          permanent (EXPUNGE), and so is deleting a draft (it never reached the server, so there is nothing to
 *          move): those need explicit confirmation and cannot be undone.
 * WEB USAGE: the delete button/shortcut chooses `delete` vs `deletePermanently` (+ confirm dialog) from this;
 *            the server enforces the same rule; undo toast timing.
 */
import type { MessageActionType } from '../api/actions.ts';
import type { FolderRole } from '../folder/index.ts';

/** How long the server holds a move/delete before applying it, so undo restores real server state. */
export const UNDO_WINDOW_MS = 6000;
/** How long the "Geri al" toast stays: shorter than the window on purpose. */
export const UNDO_NOTICE_MS = 5000;

export type DeleteBehavior = 'move_to_trash' | 'permanent';

/** What "delete" means for messages that live in a folder of this role. */
export function deleteBehavior(role: FolderRole): DeleteBehavior {
  return role === 'trash' || role === 'junk' || role === 'drafts' ? 'permanent' : 'move_to_trash';
}

/**
 * Action types allowed for a message. Drafts/local records can only be deleted — every other action would
 * have to reach the server for a message that is not there.
 */
export function allowedActionTypes(input: { folderRole: FolderRole | null; isDraft: boolean }): ReadonlySet<MessageActionType> {
  if (input.isDraft || input.folderRole === 'drafts') return new Set<MessageActionType>(['deletePermanently']);
  return new Set<MessageActionType>([
    'markRead', 'markUnread', 'pin', 'unpin', 'archive', 'delete', 'deletePermanently', 'spam', 'restore', 'move', 'label',
  ]);
}

/**
 * CLIENT-SIDE HINT for optimistic UI: actions that MAY be reverted while the undo window is open. The server
 * is authoritative (decision D4): `MessageActionsResponse.undo` is present only when the server made that
 * operation undoable under the mobile/domain rules (mobile's `markSpam` returns no undo handle, so a server that
 * follows mobile answers `undo: null` for `spam`). The UI must offer "Geri al" from the response, not from this set.
 */
export const UNDOABLE_ACTION_TYPES: ReadonlySet<MessageActionType> = new Set<MessageActionType>([
  'archive', 'delete', 'spam', 'restore', 'move',
]);

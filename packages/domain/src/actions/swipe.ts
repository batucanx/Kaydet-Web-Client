/**
 * Swipe / quick-action resolution.
 *
 * SOURCE: mobile `lib/domain/use_cases/swipe_action_resolver.dart` (`SwipeActionResolver`, `EffectiveSwipe`;
 *         tests: `test/swipe_action_resolver_test.dart`) and the `SwipeAction` preference enum in
 *         `lib/data/services/app_settings.dart` (defaults: right = `configure`, left = `delete`).
 * PURPOSE: The user's chosen one-tap action is only a default; what actually happens depends on the folder and
 *          the message state.
 *          - Archive / "read and archive" mean nothing in Archive, Trash or Junk (already there, or about to be
 *            restored) → "move to Inbox".
 *          - Delete is "delete" everywhere; trash-vs-permanent and confirmation are the delete flow's job.
 *          - "Read" and "pin" toggle on the message's current state.
 *          - Drafts/local records never reached the server: only delete works, everything else is off.
 * WEB USAGE: hover quick actions, keyboard shortcuts and any future gesture on a list row use this to decide
 *            what a one-tap action does; the UI only draws and runs the result.
 */
import type { FolderRole } from '../folder/index.ts';

/** mobile `SwipeAction` (the stored preference). Order is significant on mobile; here it is just a name. */
export const SWIPE_ACTIONS = ['archive', 'delete', 'toggleRead', 'readAndArchive', 'pin', 'none', 'configure'] as const;
export type SwipeAction = (typeof SWIPE_ACTIONS)[number];

/** Defaults: right = the "configure" placeholder (first run opens the settings), left = delete. */
export const DEFAULT_SWIPE_RIGHT: SwipeAction = 'configure';
export const DEFAULT_SWIPE_LEFT: SwipeAction = 'delete';

export const EFFECTIVE_SWIPES = [
  'none', 'archive', 'moveToInbox', 'delete', 'markRead', 'markUnread', 'pin', 'unpin', 'configure',
] as const;
/** What a one-tap action really does right now. */
export type EffectiveSwipe = (typeof EFFECTIVE_SWIPES)[number];

/** Folder roles in which "archive" is replaced by "move to Inbox". */
export const RESTORES_TO_INBOX_ROLES: readonly FolderRole[] = ['archive', 'trash', 'junk'];

export const restoresToInbox = (role: FolderRole | null | undefined): boolean =>
  role != null && RESTORES_TO_INBOX_ROLES.includes(role);

export function resolveSwipe(input: {
  selected: SwipeAction;
  /** `null` = unknown folder (e.g. a cross-folder view). */
  folder: FolderRole | null;
  isDraftOrLocal: boolean;
  isSeen: boolean;
  isPinned: boolean;
}): EffectiveSwipe {
  const { selected, folder } = input;
  if (input.isDraftOrLocal || folder === 'drafts') return selected === 'delete' ? 'delete' : 'none';

  switch (selected) {
    case 'none': return 'none';
    case 'configure': return 'configure';
    case 'delete': return 'delete';
    case 'archive':
    case 'readAndArchive':
      return restoresToInbox(folder) ? 'moveToInbox' : 'archive';
    case 'toggleRead': return input.isSeen ? 'markUnread' : 'markRead';
    case 'pin': return input.isPinned ? 'unpin' : 'pin';
  }
}

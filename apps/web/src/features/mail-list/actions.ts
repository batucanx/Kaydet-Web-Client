import { Archive, FolderInput, MailOpen, Mail, OctagonAlert, Pin, PinOff, Tag, Trash2, Undo2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FolderRole, MessageSummary } from '../../data/types';

/**
 * The action set is exactly what mobile supports: read/unread, pin, archive, delete, move,
 * spam, restore, label (+ undo, handled by the notice). No others.
 */
export type ActionId =
  | 'archive'
  | 'restore'
  | 'delete'
  | 'move'
  | 'label'
  | 'spam'
  | 'markRead'
  | 'markUnread'
  | 'pin'
  | 'unpin';

export interface ActionSpec {
  id: ActionId;
  label: string;
  icon: LucideIcon;
  danger?: boolean;
}

/** `pinned` = the virtual Sabitlenenler view (messages from any folder). */
export type ListContext = FolderRole | 'pinned';

const SPECS: Record<ActionId, ActionSpec> = {
  archive: { id: 'archive', label: 'Arşivle', icon: Archive },
  // mobile: SwipeActionResolver → "Gelen Kutusuna taşı" in Archive / Trash / Junk.
  restore: { id: 'restore', label: 'Gelen Kutusuna taşı', icon: Undo2 },
  delete: { id: 'delete', label: 'Sil', icon: Trash2, danger: true },
  move: { id: 'move', label: 'Taşı', icon: FolderInput },
  label: { id: 'label', label: 'Etiket', icon: Tag },
  spam: { id: 'spam', label: 'İstenmeyen olarak işaretle', icon: OctagonAlert },
  markRead: { id: 'markRead', label: 'Okundu işaretle', icon: MailOpen },
  markUnread: { id: 'markUnread', label: 'Okunmadı işaretle', icon: Mail },
  pin: { id: 'pin', label: 'Sabitle', icon: Pin },
  unpin: { id: 'unpin', label: 'Sabitlemeyi kaldır', icon: PinOff },
};

export const actionSpec = (id: ActionId): ActionSpec => SPECS[id];

const RESTORES_TO_INBOX: ReadonlySet<ListContext> = new Set<ListContext>(['archive', 'trash', 'junk']);

/** Deleting here is permanent (mobile: FolderMapping.deleteIsPermanent + Drafts). */
export const isPermanentDelete = (ctx: ListContext): boolean => ctx === 'trash' || ctx === 'junk' || ctx === 'drafts';

/**
 * Actions available for a selection, in display order. Mirrors mobile `SwipeActionResolver`:
 * drafts are local — only delete; archive becomes "move to Inbox" in Archive/Trash/Junk;
 * read and pin are toggles that flip based on the selection's state.
 */
export function availableActions(ctx: ListContext, messages: readonly MessageSummary[]): ActionSpec[] {
  if (ctx === 'drafts' || (messages.length > 0 && messages.every((m) => m.draft))) return [SPECS.delete];

  const out: ActionSpec[] = [RESTORES_TO_INBOX.has(ctx) ? SPECS.restore : SPECS.archive, SPECS.delete, SPECS.move, SPECS.label];
  if (ctx !== 'junk') out.push(SPECS.spam);
  out.push(messages.some((m) => !m.seen) ? SPECS.markRead : SPECS.markUnread);
  out.push(messages.some((m) => !m.pinned) ? SPECS.pin : SPECS.unpin);
  return out;
}

/** Quick actions shown on row hover (mobile swipe defaults + the two toggles). */
export const QUICK_ACTION_IDS: readonly ActionId[] = ['archive', 'restore', 'delete', 'markRead', 'markUnread', 'pin', 'unpin'];

/**
 * Predicted outcome of an action on a message — the basis of optimistic UI.
 *
 * SOURCE: the local effect each mobile `MailRepository` method writes immediately before the server round
 *         trip (`setSeen`, `setFlagged`, `moveToMailbox`, `deleteMessages`, `deletePermanently`, `setLabel`).
 * PURPOSE: The client applies the predicted result at once and reconciles with the server's answer (rollback
 *          only for messages listed in `failed`). The same function documents what the server must produce, so
 *          both sides agree on "what does archive do to this row".
 *          Moves relocate the message: it disappears from the folder being viewed. When the target folder cannot
 *          be resolved locally (e.g. the account has no Archive yet — the server creates it) the outcome is
 *          `moved` with `toFolderId: null`: hide the row, do not guess an id.
 * WEB USAGE: the data layer's optimistic update (mock now, API client later) and tests of server handlers.
 */
import type { MessageAction } from '../api/actions.ts';
import type { FolderRole } from '../folder/index.ts';
import { allowedActionTypes, deleteBehavior } from './rules.ts';

/** The message fields an action can read or change. */
export interface ActionableMessage {
  readonly id: string;
  readonly accountId: string;
  readonly folderId: string;
  readonly seen: boolean;
  readonly pinned: boolean;
  readonly draft: boolean;
  readonly labels: readonly string[];
}

export interface ActionContext {
  readonly folders: ReadonlyArray<{ readonly id: string; readonly accountId: string; readonly role: FolderRole }>;
  readonly labels: ReadonlyArray<{ readonly id: string; readonly accountId: string; readonly name: string }>;
}

export type RejectionReason =
  /** Drafts/local records only support deletion. */
  | 'draft_only_delete'
  /** `delete` in Trash/Junk/Drafts: irreversible, must be `deletePermanently`. */
  | 'permanent_delete_required'
  | 'unknown_folder'
  | 'unknown_label';

export type ActionOutcome<T extends ActionableMessage> =
  | { readonly kind: 'updated'; readonly message: T }
  | { readonly kind: 'moved'; readonly message: T; readonly toFolderId: string | null }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'rejected'; readonly reason: RejectionReason };

/** Folder of an account by role (system folders exist once per account). */
export function folderIdByRole(ctx: ActionContext, accountId: string, role: FolderRole): string | null {
  return ctx.folders.find((f) => f.accountId === accountId && f.role === role)?.id ?? null;
}

const move = <T extends ActionableMessage>(m: T, target: string | null): ActionOutcome<T> => {
  if (target === m.folderId) return { kind: 'updated', message: m }; // already there: nothing to do
  return { kind: 'moved', message: target === null ? m : { ...m, folderId: target }, toFolderId: target };
};

/** Predicts one action on one message. */
export function predictAction<T extends ActionableMessage>(message: T, action: MessageAction, ctx: ActionContext): ActionOutcome<T> {
  const role = ctx.folders.find((f) => f.id === message.folderId)?.role ?? null;
  const allowed = allowedActionTypes({ folderRole: role, isDraft: message.draft });
  if (!allowed.has(action.type)) {
    return { kind: 'rejected', reason: action.type === 'delete' ? 'permanent_delete_required' : 'draft_only_delete' };
  }

  switch (action.type) {
    case 'markRead':
      return { kind: 'updated', message: { ...message, seen: true } };
    case 'markUnread':
      return { kind: 'updated', message: { ...message, seen: false } };
    case 'pin':
      return { kind: 'updated', message: { ...message, pinned: true } };
    case 'unpin':
      return { kind: 'updated', message: { ...message, pinned: false } };
    case 'label': {
      const label = ctx.labels.find((l) => l.id === action.labelId && l.accountId === message.accountId);
      if (!label) return { kind: 'rejected', reason: 'unknown_label' };
      const has = message.labels.includes(label.name);
      if (action.mode === 'add') {
        return { kind: 'updated', message: has ? message : { ...message, labels: [...message.labels, label.name] } };
      }
      return { kind: 'updated', message: has ? { ...message, labels: message.labels.filter((n) => n !== label.name) } : message };
    }
    case 'archive':
      return move(message, folderIdByRole(ctx, message.accountId, 'archive'));
    case 'spam':
      return move(message, folderIdByRole(ctx, message.accountId, 'junk'));
    case 'restore':
      return move(message, folderIdByRole(ctx, message.accountId, 'inbox'));
    case 'delete':
      if (role !== null && deleteBehavior(role) === 'permanent') return { kind: 'rejected', reason: 'permanent_delete_required' };
      return move(message, folderIdByRole(ctx, message.accountId, 'trash'));
    case 'deletePermanently':
      return { kind: 'deleted' };
    case 'move': {
      const target = ctx.folders.find((f) => f.id === action.folderId && f.accountId === message.accountId);
      if (!target) return { kind: 'rejected', reason: 'unknown_folder' };
      return move(message, target.id);
    }
  }
}

/**
 * Predicts an ordered list of actions (one request). A move/delete ends up as the final relocation; flag and
 * label changes accumulate on the message. A rejected action rejects the whole message (the server applies a
 * request all-or-nothing per message).
 */
export function predictActions<T extends ActionableMessage>(message: T, actions: readonly MessageAction[], ctx: ActionContext): ActionOutcome<T> {
  let current: T = message;
  let relocation: { toFolderId: string | null } | null = null;
  for (const action of actions) {
    const outcome = predictAction(current, action, ctx);
    if (outcome.kind === 'rejected' || outcome.kind === 'deleted') return outcome;
    current = outcome.message;
    if (outcome.kind === 'moved') relocation = { toFolderId: outcome.toFolderId };
  }
  return relocation ? { kind: 'moved', message: current, toFolderId: relocation.toFolderId } : { kind: 'updated', message: current };
}

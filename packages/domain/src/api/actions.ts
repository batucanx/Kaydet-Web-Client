/**
 * Message action contract (`POST /messages/actions`, `POST /actions/:token/undo`).
 *
 * SOURCE: mobile `MailRepository` (`setSeen`, `setFlagged`, `archive`, `deleteMessages`, `deletePermanently`,
 *         `markSpam`, `restoreToInbox`, `moveToFolder`, `setLabel`) and `lib/ui/core/actions/message_actions.dart`
 *         (undo window, permanent-delete confirmation).
 * PURPOSE: One strongly typed action model.
 *  - `messageIds` are ALWAYS scoped by `accountId`; a batch never spans accounts (mobile returns "nothing to do"
 *    for a mixed batch, the server answers `message_scope_mismatch`).
 *  - `actions` is a short ordered list so "mark read + archive" is ONE request with ONE undo.
 *  - `delete` moves to Trash and is undoable. In Trash/Junk/Drafts deleting is irreversible: the client must send
 *    `deletePermanently` with `confirmed: true`, and the server refuses a `delete` there
 *    (`permanent_delete_requires_confirmation`), so an unconfirmed permanent delete cannot happen by accident.
 *    `deleteBehavior(folderRole)` (actions/) tells the client which one applies.
 *  - Optimistic UI: the outcome of every action on a known message is predictable (`predictActionOutcome`), so
 *    the client updates immediately and reconciles with the response (`failed` per message).
 *  - Undo: the response carries (only when the server made the operation undoable, D4) an OPAQUE token and an expiry. Pending-operation internals (queue rows, retry
 *    counters, IMAP commands) never reach the browser. An expired/unknown token answers `restored: false`
 *    (mobile "İşlem geri alınamadı.").
 */
import { z } from 'zod';
import { ApiErrorSchema } from './errors.ts';
import { IdSchema, IsoDateTimeSchema } from './common.ts';

/** Upper bound for one batch: mobile keeps 500 messages per folder in its local window. */
export const MAX_ACTION_BATCH = 500;

export const MessageActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('markRead') }),
  z.strictObject({ type: z.literal('markUnread') }),
  z.strictObject({ type: z.literal('pin') }),
  z.strictObject({ type: z.literal('unpin') }),
  /** Move to the account's Archive (created if missing). */
  z.strictObject({ type: z.literal('archive') }),
  /** Move to Trash (undoable). Not valid in Trash/Junk/Drafts — see `deletePermanently`. */
  z.strictObject({ type: z.literal('delete') }),
  /** Irreversible. `confirmed` must be the literal `true`: the caller asserts the user confirmed. */
  z.strictObject({ type: z.literal('deletePermanently'), confirmed: z.literal(true) }),
  /** Move to Junk. Server-resolved like every action: whether it is undoable is the server's decision (D4). */
  z.strictObject({ type: z.literal('spam') }),
  /** Move back to the Inbox (from Archive/Trash/Junk). */
  z.strictObject({ type: z.literal('restore') }),
  /** Move to an exact folder of the same account (including user-created ones). */
  z.strictObject({ type: z.literal('move'), folderId: IdSchema }),
  z.strictObject({ type: z.literal('label'), labelId: IdSchema, mode: z.enum(['add', 'remove']) }),
]);
export type MessageAction = z.infer<typeof MessageActionSchema>;
export type MessageActionType = MessageAction['type'];

/** Actions that relocate or remove the message; at most one per request. */
export const MOVE_LIKE_ACTIONS = ['archive', 'delete', 'deletePermanently', 'spam', 'restore', 'move'] as const satisfies readonly MessageActionType[];
export const isMoveLikeAction = (type: MessageActionType): boolean => (MOVE_LIKE_ACTIONS as readonly string[]).includes(type);

export const MessageActionsRequestSchema = z
  .strictObject({
    accountId: IdSchema,
    messageIds: z.array(IdSchema).min(1).max(MAX_ACTION_BATCH),
    actions: z.array(MessageActionSchema).min(1).max(4),
  })
  .superRefine((req, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    if (new Set(req.messageIds).size !== req.messageIds.length) issue(['messageIds'], 'messageIds must be unique');

    const types = req.actions.map((a) => a.type);
    if (types.filter(isMoveLikeAction).length > 1) issue(['actions'], 'at most one move/delete action per request');
    if (types.includes('deletePermanently') && types.length > 1) issue(['actions'], 'deletePermanently must be sent alone');
    const conflicts: Array<[MessageActionType, MessageActionType]> = [['markRead', 'markUnread'], ['pin', 'unpin']];
    for (const [a, b] of conflicts) if (types.includes(a) && types.includes(b)) issue(['actions'], `${a} and ${b} conflict`);
    // Repeats make no sense, except several DIFFERENT labels in one go (the same label twice is a conflict).
    const seen = new Set<string>();
    for (const action of req.actions) {
      const key = action.type === 'label' ? `label:${action.labelId}` : action.type;
      if (seen.has(key)) issue(['actions'], `duplicate ${action.type}`);
      seen.add(key);
    }
  });
export type MessageActionsRequest = z.infer<typeof MessageActionsRequestSchema>;

/** Opaque, unguessable, URL-safe. */
export const UndoTokenSchema = z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/);

export const UndoInfoSchema = z.strictObject({ token: UndoTokenSchema, expiresAt: IsoDateTimeSchema });
export type UndoInfo = z.infer<typeof UndoInfoSchema>;

export const MessageActionsResponseSchema = z.strictObject({
  accountId: IdSchema,
  /** Messages the actions were applied to (already reflected server-side). */
  appliedIds: z.array(IdSchema),
  /** Per-message failures: a batch can partly succeed. The client rolls back only these. */
  failed: z.array(z.strictObject({ messageId: IdSchema, error: ApiErrorSchema })),
  /** Present when at least one applied action can be reverted; `null` otherwise (flag-only changes). */
  undo: UndoInfoSchema.nullable(),
});
export type MessageActionsResponse = z.infer<typeof MessageActionsResponseSchema>;

export const UndoResponseSchema = z.strictObject({ restored: z.boolean() });
export type UndoResponse = z.infer<typeof UndoResponseSchema>;

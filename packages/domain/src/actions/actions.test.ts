import { describe, expect, it } from 'vitest';
import type { MessageAction } from '../api/actions.ts';
import { FOLDER_ROLES } from '../folder/index.ts';
import type { FolderRole } from '../folder/index.ts';
import {
  DEFAULT_SWIPE_LEFT,
  DEFAULT_SWIPE_RIGHT,
  SWIPE_ACTIONS,
  UNDOABLE_ACTION_TYPES,
  UNDO_NOTICE_MS,
  UNDO_WINDOW_MS,
  allowedActionTypes,
  deleteBehavior,
  folderIdByRole,
  predictAction,
  predictActions,
  resolveSwipe,
  restoresToInbox,
} from './index.ts';
import type { ActionContext, ActionableMessage, EffectiveSwipe, SwipeAction } from './index.ts';

describe('resolveSwipe (mobile swipe_action_resolver_test.dart)', () => {
  const resolve = (
    selected: SwipeAction,
    o: { folder?: FolderRole | null; draft?: boolean; seen?: boolean; pinned?: boolean } = {},
  ): EffectiveSwipe =>
    resolveSwipe({
      selected,
      folder: o.folder === undefined ? 'inbox' : o.folder,
      isDraftOrLocal: o.draft ?? false,
      isSeen: o.seen ?? false,
      isPinned: o.pinned ?? false,
    });

  it('Inbox + archive → archive', () => expect(resolve('archive')).toBe('archive'));

  it('Archive + archive → move to Inbox', () => {
    expect(resolve('archive', { folder: 'archive' })).toBe('moveToInbox');
  });

  it('Trash and Junk + archive / read-and-archive → move to Inbox', () => {
    for (const folder of ['trash', 'junk'] as const) {
      expect(resolve('archive', { folder })).toBe('moveToInbox');
      expect(resolve('readAndArchive', { folder })).toBe('moveToInbox');
    }
  });

  it('delete is delete in every folder', () => {
    for (const folder of FOLDER_ROLES) expect(resolve('delete', { folder })).toBe('delete');
  });

  it('pin toggles', () => {
    expect(resolve('pin')).toBe('pin');
    expect(resolve('pin', { pinned: true })).toBe('unpin');
  });

  it('read toggles', () => {
    expect(resolve('toggleRead')).toBe('markRead');
    expect(resolve('toggleRead', { seen: true })).toBe('markUnread');
  });

  it('none → no action', () => expect(resolve('none')).toBe('none'));

  it('drafts / local records can only be deleted', () => {
    expect(resolve('delete', { draft: true })).toBe('delete');
    expect(resolve('archive', { draft: true })).toBe('none');
    expect(resolve('pin', { draft: true })).toBe('none');
    expect(resolve('archive', { folder: 'drafts' })).toBe('none');
    expect(resolve('toggleRead', { folder: 'drafts' })).toBe('none');
  });

  it('first-run defaults: right = configure placeholder, left = delete; both directions independent', () => {
    expect(DEFAULT_SWIPE_RIGHT).toBe('configure');
    expect(DEFAULT_SWIPE_LEFT).toBe('delete');
    expect(resolve('configure')).toBe('configure');
    // In drafts "configure" is off too (only delete stays on).
    expect(resolve('configure', { draft: true })).toBe('none');
  });

  it('an unknown folder (cross-folder view) never restores to Inbox', () => {
    expect(resolve('archive', { folder: null })).toBe('archive');
  });

  it('every preference resolves to something for every folder', () => {
    for (const selected of SWIPE_ACTIONS) for (const folder of FOLDER_ROLES) expect(resolve(selected, { folder })).toBeTruthy();
  });

  it('restoresToInbox', () => {
    expect(restoresToInbox('archive')).toBe(true);
    expect(restoresToInbox('trash')).toBe(true);
    expect(restoresToInbox('junk')).toBe(true);
    expect(restoresToInbox('inbox')).toBe(false);
    expect(restoresToInbox(null)).toBe(false);
  });
});

describe('delete semantics & undo timing (mobile folder_mapping_test.dart / message_actions.dart)', () => {
  it('Trash, Junk and Drafts delete permanently; everything else moves to Trash', () => {
    expect(deleteBehavior('trash')).toBe('permanent');
    expect(deleteBehavior('junk')).toBe('permanent');
    expect(deleteBehavior('drafts')).toBe('permanent');
    for (const role of ['inbox', 'sent', 'archive', 'custom'] as const) expect(deleteBehavior(role)).toBe('move_to_trash');
  });

  it('the toast is shorter than the undo window, so a visible "Geri al" is always valid', () => {
    expect(UNDO_WINDOW_MS).toBe(6000);
    expect(UNDO_NOTICE_MS).toBe(5000);
    expect(UNDO_NOTICE_MS).toBeLessThan(UNDO_WINDOW_MS);
  });

  it('only relocations are undoable, never flag or label changes or permanent deletes', () => {
    expect([...UNDOABLE_ACTION_TYPES].sort()).toEqual(['archive', 'delete', 'move', 'restore', 'spam']);
  });

  it('drafts allow only permanent deletion', () => {
    expect([...allowedActionTypes({ folderRole: 'drafts', isDraft: false })]).toEqual(['deletePermanently']);
    expect([...allowedActionTypes({ folderRole: 'inbox', isDraft: true })]).toEqual(['deletePermanently']);
    expect(allowedActionTypes({ folderRole: 'inbox', isDraft: false }).size).toBe(11);
  });
});

describe('predictAction / predictActions (optimistic outcomes)', () => {
  const ctx: ActionContext = {
    folders: [
      { id: 'a1_inbox', accountId: 'a1', role: 'inbox' },
      { id: 'a1_archive', accountId: 'a1', role: 'archive' },
      { id: 'a1_trash', accountId: 'a1', role: 'trash' },
      { id: 'a1_junk', accountId: 'a1', role: 'junk' },
      { id: 'a1_drafts', accountId: 'a1', role: 'drafts' },
      { id: 'a1_proj', accountId: 'a1', role: 'custom' },
      { id: 'a2_inbox', accountId: 'a2', role: 'inbox' },
      { id: 'a2_x', accountId: 'a2', role: 'custom' },
    ],
    labels: [
      { id: 'l1', accountId: 'a1', name: 'İş' },
      { id: 'l9', accountId: 'a2', name: 'Diğer' },
    ],
  };
  const msg = (over: Partial<ActionableMessage> = {}): ActionableMessage => ({
    id: 'm1', accountId: 'a1', folderId: 'a1_inbox', seen: false, pinned: false, draft: false, labels: [], ...over,
  });
  const act = (a: MessageAction) => a;

  it('flags update in place and never mutate the input', () => {
    const m = msg();
    expect(predictAction(m, act({ type: 'markRead' }), ctx)).toEqual({ kind: 'updated', message: { ...m, seen: true } });
    expect(predictAction(msg({ seen: true }), act({ type: 'markUnread' }), ctx)).toMatchObject({ message: { seen: false } });
    expect(predictAction(m, act({ type: 'pin' }), ctx)).toMatchObject({ message: { pinned: true } });
    expect(predictAction(msg({ pinned: true }), act({ type: 'unpin' }), ctx)).toMatchObject({ message: { pinned: false } });
    expect(m.seen).toBe(false);
  });

  it('archive / spam / restore / delete move to the role folder of the SAME account', () => {
    expect(predictAction(msg(), act({ type: 'archive' }), ctx)).toMatchObject({ kind: 'moved', toFolderId: 'a1_archive', message: { folderId: 'a1_archive' } });
    expect(predictAction(msg(), act({ type: 'spam' }), ctx)).toMatchObject({ kind: 'moved', toFolderId: 'a1_junk' });
    expect(predictAction(msg({ folderId: 'a1_trash' }), act({ type: 'restore' }), ctx)).toMatchObject({ kind: 'moved', toFolderId: 'a1_inbox' });
    expect(predictAction(msg(), act({ type: 'delete' }), ctx)).toMatchObject({ kind: 'moved', toFolderId: 'a1_trash' });
    expect(predictAction(msg({ accountId: 'a2', folderId: 'a2_x' }), act({ type: 'archive' }), ctx)).toMatchObject({
      kind: 'moved',
      toFolderId: null, // account 2 has no Archive yet: the server creates it — hide the row, do not guess an id
    });
  });

  it('moving to the folder it is already in changes nothing', () => {
    expect(predictAction(msg({ folderId: 'a1_archive' }), act({ type: 'archive' }), ctx)).toMatchObject({ kind: 'updated' });
    expect(predictAction(msg(), act({ type: 'move', folderId: 'a1_inbox' }), ctx)).toMatchObject({ kind: 'updated' });
  });

  it('move to an exact folder; a folder of another account is unknown', () => {
    expect(predictAction(msg(), act({ type: 'move', folderId: 'a1_proj' }), ctx)).toMatchObject({ kind: 'moved', toFolderId: 'a1_proj' });
    expect(predictAction(msg(), act({ type: 'move', folderId: 'a2_x' }), ctx)).toEqual({ kind: 'rejected', reason: 'unknown_folder' });
    expect(predictAction(msg(), act({ type: 'move', folderId: 'nope' }), ctx)).toEqual({ kind: 'rejected', reason: 'unknown_folder' });
  });

  it('delete in Trash/Junk is refused (must be deletePermanently); permanent delete removes the row', () => {
    expect(predictAction(msg({ folderId: 'a1_trash' }), act({ type: 'delete' }), ctx)).toEqual({ kind: 'rejected', reason: 'permanent_delete_required' });
    expect(predictAction(msg({ folderId: 'a1_junk' }), act({ type: 'delete' }), ctx)).toEqual({ kind: 'rejected', reason: 'permanent_delete_required' });
    expect(predictAction(msg({ folderId: 'a1_trash' }), act({ type: 'deletePermanently', confirmed: true }), ctx)).toEqual({ kind: 'deleted' });
  });

  it('drafts: only permanent delete', () => {
    const draft = msg({ folderId: 'a1_drafts', draft: true });
    expect(predictAction(draft, act({ type: 'markRead' }), ctx)).toEqual({ kind: 'rejected', reason: 'draft_only_delete' });
    expect(predictAction(draft, act({ type: 'archive' }), ctx)).toEqual({ kind: 'rejected', reason: 'draft_only_delete' });
    expect(predictAction(draft, act({ type: 'delete' }), ctx)).toEqual({ kind: 'rejected', reason: 'permanent_delete_required' });
    expect(predictAction(draft, act({ type: 'deletePermanently', confirmed: true }), ctx)).toEqual({ kind: 'deleted' });
  });

  it('labels add/remove by id, idempotently; a foreign or unknown label is refused', () => {
    const add = act({ type: 'label', labelId: 'l1', mode: 'add' });
    const once = predictAction(msg(), add, ctx);
    expect(once).toMatchObject({ kind: 'updated', message: { labels: ['İş'] } });
    const m = msg({ labels: ['İş'] });
    expect(predictAction(m, add, ctx)).toEqual({ kind: 'updated', message: m });
    expect(predictAction(m, act({ type: 'label', labelId: 'l1', mode: 'remove' }), ctx)).toMatchObject({ message: { labels: [] } });
    expect(predictAction(msg(), act({ type: 'label', labelId: 'l9', mode: 'add' }), ctx)).toEqual({ kind: 'rejected', reason: 'unknown_label' });
    expect(predictAction(msg(), act({ type: 'label', labelId: 'zzz', mode: 'add' }), ctx)).toEqual({ kind: 'rejected', reason: 'unknown_label' });
  });

  it('a batch combines flag changes with one relocation (read + archive)', () => {
    const r = predictActions(msg(), [act({ type: 'markRead' }), act({ type: 'archive' })], ctx);
    expect(r).toMatchObject({ kind: 'moved', toFolderId: 'a1_archive', message: { seen: true, folderId: 'a1_archive' } });
    // Order does not matter for the result.
    const r2 = predictActions(msg(), [act({ type: 'archive' }), act({ type: 'markRead' })], ctx);
    expect(r2).toMatchObject({ kind: 'moved', toFolderId: 'a1_archive', message: { seen: true } });
  });

  it('flag-only batches stay "updated"; a rejected step rejects the message; empty batch is a no-op', () => {
    expect(predictActions(msg(), [act({ type: 'markRead' }), act({ type: 'pin' })], ctx)).toMatchObject({
      kind: 'updated',
      message: { seen: true, pinned: true },
    });
    expect(predictActions(msg(), [act({ type: 'markRead' }), act({ type: 'move', folderId: 'zzz' })], ctx)).toEqual({
      kind: 'rejected',
      reason: 'unknown_folder',
    });
    expect(predictActions(msg(), [], ctx)).toMatchObject({ kind: 'updated' });
  });

  it('preserves extra fields of the caller\'s message type', () => {
    const r = predictAction({ ...msg(), subject: 'Merhaba' }, act({ type: 'markRead' }), ctx);
    expect(r.kind === 'updated' && r.message.subject).toBe('Merhaba');
  });

  it('folderIdByRole finds a system folder per account', () => {
    expect(folderIdByRole(ctx, 'a1', 'trash')).toBe('a1_trash');
    expect(folderIdByRole(ctx, 'a2', 'trash')).toBeNull();
  });
});

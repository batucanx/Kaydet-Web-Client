import { describe, expect, it } from 'vitest';
import type { MessageSummary } from '../../data/types';
import { availableActions, isPermanentDelete } from './actions';
import { buildListItems, visibleMessageIds } from './listItems';
import { EMPTY_SELECTION, selectionReducer } from './selection';

const now = new Date(2026, 8, 30, 15, 0);

function msg(id: string, date: Date, over: Partial<MessageSummary> = {}): MessageSummary {
  return {
    id,
    accountId: 'a',
    folderId: 'a_inbox',
    threadId: id,
    from: { name: 'X', email: 'x@example.com' },
    to: [],
    subject: 's',
    preview: 'p',
    date: date.toISOString(),
    seen: true,
    pinned: false,
    answered: false,
    forwarded: false,
    draft: false,
    hasAttachments: false,
    labels: [],
    outbox: { state: 'none' },
    ...over,
  };
}

describe('buildListItems (mobile: mailListItemsProvider)', () => {
  const today = msg('1', new Date(2026, 8, 30, 9, 0));
  const today2 = msg('2', new Date(2026, 8, 30, 8, 0));
  const yesterday = msg('3', new Date(2026, 8, 29, 9, 0));
  const pinned = msg('4', new Date(2026, 8, 20, 9, 0), { pinned: true });

  it('groups consecutive messages under one date header', () => {
    const items = buildListItems({ messages: [today, today2, yesterday], pinned: [], showPinned: false, pinnedExpanded: true, sort: 'dateDesc', now });
    expect(items.map((i) => (i.kind === 'date' ? i.label : i.kind === 'message' ? i.message.id : i.kind))).toEqual([
      'Bugün', '1', '2', 'Dün', '3',
    ]);
  });

  it('does not group when sorted by sender/subject', () => {
    const items = buildListItems({ messages: [today, yesterday], pinned: [], showPinned: false, pinnedExpanded: true, sort: 'senderAZ', now });
    expect(items.every((i) => i.kind === 'message')).toBe(true);
  });

  it('puts pinned messages in their own section and excludes them from the list', () => {
    const items = buildListItems({ messages: [today, pinned], pinned: [pinned], showPinned: true, pinnedExpanded: true, sort: 'dateDesc', now });
    expect(items[0]).toEqual({ kind: 'pinned-header', count: 1, expanded: true });
    expect(items.filter((i) => i.kind === 'message').map((i) => (i.kind === 'message' ? `${i.section}:${i.message.id}` : ''))).toEqual([
      'pinned:4', 'list:1',
    ]);
  });

  it('collapses the pinned section but keeps its header', () => {
    const items = buildListItems({ messages: [today], pinned: [pinned], showPinned: true, pinnedExpanded: false, sort: 'dateDesc', now });
    expect(items.some((i) => i.kind === 'pinned-header')).toBe(true);
    expect(visibleMessageIds(items)).toEqual(['1']);
  });

  it('shows no pinned section when not applicable (non-Inbox / filter active)', () => {
    const items = buildListItems({ messages: [pinned], pinned: [pinned], showPinned: false, pinnedExpanded: true, sort: 'dateDesc', now });
    expect(items.some((i) => i.kind === 'pinned-header')).toBe(false);
    expect(visibleMessageIds(items)).toEqual(['4']);
  });
});

describe('selectionReducer', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];

  it('toggles and tracks the anchor', () => {
    const s1 = selectionReducer(EMPTY_SELECTION, { type: 'toggle', id: 'b' });
    expect([...s1.ids]).toEqual(['b']);
    const s2 = selectionReducer(s1, { type: 'toggle', id: 'b' });
    expect(s2.ids.size).toBe(0);
  });

  it('selects a range from the anchor (Shift)', () => {
    const s1 = selectionReducer(EMPTY_SELECTION, { type: 'toggle', id: 'b' });
    const s2 = selectionReducer(s1, { type: 'range', id: 'd', order });
    expect([...s2.ids].sort()).toEqual(['b', 'c', 'd']);
  });

  it('range without an anchor behaves like toggle', () => {
    expect([...selectionReducer(EMPTY_SELECTION, { type: 'range', id: 'c', order }).ids]).toEqual(['c']);
  });

  it('prunes ids that are no longer visible', () => {
    const s1 = selectionReducer(EMPTY_SELECTION, { type: 'selectAll', order });
    const s2 = selectionReducer(s1, { type: 'prune', order: ['a', 'c'] });
    expect([...s2.ids].sort()).toEqual(['a', 'c']);
  });

  it('clear returns the same reference when already empty (no re-render)', () => {
    expect(selectionReducer(EMPTY_SELECTION, { type: 'clear' })).toBe(EMPTY_SELECTION);
  });
});

describe('availableActions (mobile: SwipeActionResolver + selection bar)', () => {
  const unread = msg('u', now, { seen: false });
  const read = msg('r', now, { seen: true, pinned: true });
  const ids = (ctx: Parameters<typeof availableActions>[0], m: MessageSummary[]) => availableActions(ctx, m).map((a) => a.id);

  it('Inbox: archive, delete, move, label, spam, read toggle, pin toggle', () => {
    expect(ids('inbox', [unread])).toEqual(['archive', 'delete', 'move', 'label', 'spam', 'markRead', 'pin']);
  });

  it('Archive/Trash/Junk: archive becomes "move to Inbox"', () => {
    for (const ctx of ['archive', 'trash', 'junk'] as const) expect(ids(ctx, [unread])).toContain('restore');
    expect(ids('archive', [unread])).not.toContain('archive');
  });

  it('Junk offers no spam action', () => {
    expect(ids('junk', [unread])).not.toContain('spam');
  });

  it('Drafts: delete only', () => {
    expect(ids('drafts', [msg('d', now, { draft: true })])).toEqual(['delete']);
  });

  it('toggles flip with selection state', () => {
    expect(ids('inbox', [read])).toEqual(expect.arrayContaining(['markUnread', 'unpin']));
    expect(ids('inbox', [read, unread])).toEqual(expect.arrayContaining(['markRead', 'pin']));
  });

  it('permanent delete only in Trash / Junk / Drafts', () => {
    expect(['trash', 'junk', 'drafts'].every((c) => isPermanentDelete(c as never))).toBe(true);
    expect(['inbox', 'sent', 'archive', 'custom', 'pinned'].some((c) => isPermanentDelete(c as never))).toBe(false);
  });
});

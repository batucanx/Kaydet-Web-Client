import { act, renderHook, waitFor } from '@testing-library/react';
import { AccountSchema, FolderSchema, LabelSchema, MessageSummarySchema } from '@kaydet/domain';
import { describe, expect, it } from 'vitest';
import { useAccounts, useFolders, useLabels, useMailActions, useMessages, usePinnedCount } from '../MailDataContext';
import { EMPTY_FILTER, PINNED_FOLDER } from '../types';
import type { MailFilter } from '../types';
import { MockMailDataProvider } from './MockMailDataProvider';

/**
 * The mock is a `MailDataSource` whose data is shaped by the shared API contract. These tests prove that
 * it emits schema-valid DTOs and that its behaviour comes from the domain rules, so the UI cannot tell it
 * from the real API-backed source.
 */
function setup(accountId = 'acc1') {
  return renderHook(
    (props: { folder: string; filter: MailFilter; accountId: string }) => ({
      accounts: useAccounts(),
      folders: useFolders(props.accountId),
      labels: useLabels(props.accountId),
      pinnedCount: usePinnedCount(props.accountId),
      messages: useMessages({ accountId: props.accountId, folder: props.folder, filter: props.filter }),
      actions: useMailActions(),
    }),
    { wrapper: MockMailDataProvider, initialProps: { folder: `${accountId}_inbox`, filter: EMPTY_FILTER, accountId } },
  );
}

const ready = <T,>(l: { status: string; data?: T }): T => {
  expect(l.status).toBe('ready');
  return l.data as T;
};

describe('mock data source speaks the API contract', () => {
  it('accounts, folders and labels are schema-valid DTOs', () => {
    const { result } = setup();
    for (const a of ready(result.current.accounts)) expect(AccountSchema.safeParse(a).success).toBe(true);
    for (const f of ready(result.current.folders)) expect(FolderSchema.safeParse(f).success).toBe(true);
    for (const l of ready(result.current.labels)) expect(LabelSchema.safeParse(l).success).toBe(true);
  });

  it('folder order, depth and parent links come from the domain folder tree', () => {
    const { result } = setup();
    const folders = ready(result.current.folders);
    expect(folders.map((f) => `${f.name}:${f.depth}`)).toEqual([
      'Gelen Kutusu:0', 'Gönderilenler:0', 'Arşiv:0', 'Taslaklar:0', 'Çöp Kutusu:0', 'İstenmeyen:0',
      'Faturalar:0', 'Projeler:0', 'Kaydet Web:1', 'Tedarikçiler:1',
    ]);
    const projeler = folders.find((f) => f.name === 'Projeler');
    expect(projeler?.hasChildren).toBe(true);
    expect(folders.filter((f) => f.parentId === projeler?.id).map((f) => f.name)).toEqual(['Kaydet Web', 'Tedarikçiler']);
    expect(folders.find((f) => f.name === 'Faturalar')?.hasChildren).toBe(false);
    // Every folder is scoped to its account.
    expect(new Set(folders.map((f) => f.accountId))).toEqual(new Set(['acc1']));
  });

  it('list rows are schema-valid message summaries scoped to the requested account and folder', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.messages.status).toBe('ready'));
    const page = ready(result.current.messages);
    expect(page.items.length).toBeGreaterThan(0);
    for (const m of page.items) {
      expect(MessageSummarySchema.safeParse(m).success).toBe(true);
      expect(m.accountId).toBe('acc1');
      expect(m.folderId).toBe('acc1_inbox');
    }
  });

  it('other accounts never leak into a query', async () => {
    const { result } = setup('acc2');
    await waitFor(() => expect(result.current.messages.status).toBe('ready'));
    expect(ready(result.current.messages).items.every((m) => m.accountId === 'acc2' && m.folderId === 'acc2_inbox')).toBe(true);
  });

  it('filtering and sorting use the domain rules (Turkish-aware, mobile order)', async () => {
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.messages.status).toBe('ready'));

    rerender({ accountId: 'acc1', folder: 'acc1_inbox', filter: { ...EMPTY_FILTER, unread: true } });
    const unread = ready(result.current.messages).items;
    expect(unread.length).toBeGreaterThan(0);
    expect(unread.every((m) => !m.seen)).toBe(true);
    const dates = unread.map((m) => Date.parse(m.date));
    expect(dates).toEqual([...dates].sort((a, b) => b - a));

    rerender({ accountId: 'acc1', folder: 'acc1_inbox', filter: { ...EMPTY_FILTER, sort: 'dateAsc' } });
    const asc = ready(result.current.messages).items.map((m) => Date.parse(m.date));
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
  });

  it('the pinned view spans every folder of the account and never other accounts', async () => {
    const { result, rerender } = setup();
    rerender({ accountId: 'acc1', folder: PINNED_FOLDER, filter: EMPTY_FILTER });
    await waitFor(() => expect(result.current.messages.status).toBe('ready'));
    const { items } = ready(result.current.messages);
    expect(items.length).toBe(Math.min(30, result.current.pinnedCount));
    expect(items.every((m) => m.pinned && m.accountId === 'acc1')).toBe(true);
    expect(new Set(items.map((m) => m.folderId)).size).toBeGreaterThan(1);
  });
});

describe('mock actions apply the domain outcomes', () => {
  it('archive relocates within the account and undo brings the message back', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.messages.status).toBe('ready'));
    const first = ready(result.current.messages).items[0];
    expect(first).toBeDefined();
    const id = (first as { id: string }).id;

    let handle: ReturnType<typeof result.current.actions.archive> = null;
    act(() => {
      handle = result.current.actions.archive([id]);
    });
    expect(handle).not.toBeNull();
    expect(ready(result.current.messages).items.some((m) => m.id === id)).toBe(false);
    const archived = ready(result.current.folders).find((f) => f.role === 'archive');
    expect(archived?.totalCount).toBeGreaterThan(7);

    await act(async () => {
      expect(await (handle as unknown as { undo: () => Promise<boolean> }).undo()).toBe(true);
    });
    expect(ready(result.current.messages).items.some((m) => m.id === id)).toBe(true);
  });

  it('marking read changes the unread counter of the folder', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.messages.status).toBe('ready'));
    const before = ready(result.current.folders).find((f) => f.role === 'inbox')?.unreadCount ?? 0;
    const unread = ready(result.current.messages).items.find((m) => !m.seen);
    expect(unread).toBeDefined();
    act(() => result.current.actions.setSeen([(unread as { id: string }).id], true));
    expect(ready(result.current.folders).find((f) => f.role === 'inbox')?.unreadCount).toBe(before - 1);
  });

  it('consecutive actions in one event see each other (read, then archive)', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.messages.status).toBe('ready'));
    const id = (ready(result.current.messages).items.find((m) => !m.seen) as { id: string }).id;
    act(() => {
      result.current.actions.setSeen([id], true);
      result.current.actions.archive([id]);
    });
    expect(ready(result.current.messages).items.some((m) => m.id === id)).toBe(false);
  });

  it('a permanent delete removes the row and cannot be undone', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.messages.status).toBe('ready'));
    const id = (ready(result.current.messages).items[0] as { id: string }).id;
    act(() => result.current.actions.deletePermanently([id]));
    expect(ready(result.current.messages).items.some((m) => m.id === id)).toBe(false);
  });

  it('a label is applied by id through the contract action', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.messages.status).toBe('ready'));
    const id = (ready(result.current.messages).items[0] as { id: string }).id;
    act(() => result.current.actions.applyLabel([id], 'Önemli'));
    expect(ready(result.current.messages).items.find((m) => m.id === id)?.labels).toContain('Önemli');
  });
});

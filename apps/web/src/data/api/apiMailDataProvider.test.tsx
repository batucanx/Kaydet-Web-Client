import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AccountDTO, FolderDTO, MessagePageDTO, MessageSummaryDTO } from '@kaydet/domain';
import { ApiClient } from './client';
import { ApiMailDataProvider } from './ApiMailDataProvider';
import {
  useAccounts,
  useFolders,
  useMailActions,
  useMessages,
} from '../MailDataContext';
import { EMPTY_FILTER } from '../types';

const mockAccount: AccountDTO = {
  id: 'acc-1',
  email: 'user@example.com',
  displayName: 'User Example',
  supportsServerLabels: true,
  sync: { status: 'idle', lastSyncAt: null },
};

const mockFolders: FolderDTO[] = [
  {
    id: 'f-inbox',
    accountId: 'acc-1',
    name: 'Gelen Kutusu',
    role: 'inbox',
    parentId: null,
    depth: 0,
    hasChildren: false,
    isFavorite: false,
    unreadCount: 2,
    totalCount: 10,
  },
  {
    id: 'f-sent',
    accountId: 'acc-1',
    name: 'Gönderilenler',
    role: 'sent',
    parentId: null,
    depth: 0,
    hasChildren: false,
    isFavorite: false,
    unreadCount: 0,
    totalCount: 5,
  },
];

const mockMessages: MessageSummaryDTO[] = [
  {
    id: 'msg-1',
    accountId: 'acc-1',
    folderId: 'f-inbox',
    threadId: 't-1',
    from: { name: 'Alice', email: 'alice@example.com' },
    to: [{ name: 'User', email: 'user@example.com' }],
    subject: 'First Message',
    preview: 'Preview 1',
    date: '2026-10-01T10:00:00.000Z',
    seen: false,
    pinned: false,
    answered: false,
    forwarded: false,
    draft: false,
    hasAttachments: false,
    labels: [],
    outbox: { state: 'none' },
  },
  {
    id: 'msg-2',
    accountId: 'acc-1',
    folderId: 'f-inbox',
    threadId: 't-2',
    from: { name: 'Bob', email: 'bob@example.com' },
    to: [{ name: 'User', email: 'user@example.com' }],
    subject: 'Second Message',
    preview: 'Preview 2',
    date: '2026-10-01T11:00:00.000Z',
    seen: true,
    pinned: true,
    answered: false,
    forwarded: false,
    draft: false,
    hasAttachments: true,
    labels: ['Work'],
    outbox: { state: 'none' },
  },
];

describe('ApiMailDataProvider', () => {
  it('loads accounts via useAccounts', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ items: [mockAccount] }),
    });

    const client = new ApiClient({ baseUrl: 'http://test/api', fetchFn: mockFetch });

    function TestAccountsConsumer() {
      const accs = useAccounts();
      if (accs.status !== 'ready') return <div>Loading accounts</div>;
      return <div data-testid="accounts">{accs.data.map((a) => a.email).join(',')}</div>;
    }

    render(
      <ApiMailDataProvider client={client}>
        <TestAccountsConsumer />
      </ApiMailDataProvider>,
    );

    expect(screen.getByText('Loading accounts')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('accounts')).toHaveTextContent('user@example.com');
    });
  });

  it('loads folders for account via useFolders', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/folders')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ items: mockFolders }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ items: [] }),
      });
    });

    const client = new ApiClient({ baseUrl: 'http://test/api', fetchFn: mockFetch });

    function TestFoldersConsumer() {
      const folders = useFolders('acc-1');
      if (folders.status !== 'ready') return <div>Loading folders</div>;
      return <div data-testid="folders">{folders.data.map((f) => f.name).join(',')}</div>;
    }

    render(
      <ApiMailDataProvider client={client}>
        <TestFoldersConsumer />
      </ApiMailDataProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('folders')).toHaveTextContent('Gelen Kutusu,Gönderilenler');
    });
  });

  it('loads messages and supports pagination via useMessages', async () => {
    const user = userEvent.setup();
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('cursor=cursor-page-2')) {
        const page2: MessagePageDTO = {
          accountId: 'acc-1',
          scope: { kind: 'folder', folderId: 'f-inbox' },
          items: [
            {
              ...mockMessages[0],
              id: 'msg-3',
              subject: 'Third Message',
            },
          ],
          nextCursor: null,
        };
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => page2,
        });
      }

      const page1: MessagePageDTO = {
        accountId: 'acc-1',
        scope: { kind: 'folder', folderId: 'f-inbox' },
        items: mockMessages,
        nextCursor: 'cursor-page-2',
      };
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => page1,
      });
    });

    const client = new ApiClient({ baseUrl: 'http://test/api', fetchFn: mockFetch });

    function TestMessagesConsumer() {
      const res = useMessages({
        accountId: 'acc-1',
        folder: 'f-inbox',
        filter: EMPTY_FILTER,
      });

      if (res.status !== 'ready') return <div>Loading messages</div>;
      return (
        <div>
          <ul data-testid="msg-list">
            {res.data.items.map((m) => (
              <li key={m.id}>{m.subject}</li>
            ))}
          </ul>
          {res.data.hasMore && <button onClick={res.data.loadMore}>Load More</button>}
        </div>
      );
    }

    render(
      <ApiMailDataProvider client={client}>
        <TestMessagesConsumer />
      </ApiMailDataProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('msg-list')).toHaveTextContent('First Message');
      expect(screen.getByTestId('msg-list')).toHaveTextContent('Second Message');
    });

    const loadMoreBtn = screen.getByRole('button', { name: 'Load More' });
    await user.click(loadMoreBtn);

    await waitFor(() => {
      expect(screen.getByTestId('msg-list')).toHaveTextContent('Third Message');
      expect(screen.queryByRole('button', { name: 'Load More' })).not.toBeInTheDocument();
    });
  });

  it('performs optimistic updates and reconciles with server on message actions', async () => {
    const user = userEvent.setup();
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/actions')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            accountId: 'acc-1',
            appliedIds: ['msg-1'],
            failed: [],
            undo: { token: 'undo-token-123', expiresAt: '2026-10-01T12:00:00.000Z' },
          }),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          accountId: 'acc-1',
          scope: { kind: 'folder', folderId: 'f-inbox' },
          items: mockMessages,
          nextCursor: null,
        }),
      });
    });

    const client = new ApiClient({ baseUrl: 'http://test/api', fetchFn: mockFetch });

    function TestActionsConsumer() {
      const messages = useMessages({
        accountId: 'acc-1',
        folder: 'f-inbox',
        filter: EMPTY_FILTER,
      });
      const actions = useMailActions();

      if (messages.status !== 'ready') return <div>Loading</div>;
      const first = messages.data.items[0];

      return (
        <div>
          <span data-testid="msg-seen">{first?.seen ? 'seen' : 'unseen'}</span>
          <button onClick={() => actions.setSeen(['msg-1'], true)}>Mark Seen</button>
        </div>
      );
    }

    render(
      <ApiMailDataProvider client={client}>
        <TestActionsConsumer />
      </ApiMailDataProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('msg-seen')).toHaveTextContent('unseen');
    });

    await user.click(screen.getByRole('button', { name: 'Mark Seen' }));

    // Optimistically updated
    expect(screen.getByTestId('msg-seen')).toHaveTextContent('seen');

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/messages/actions'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            accountId: 'acc-1',
            messageIds: ['msg-1'],
            actions: [{ type: 'markRead' }],
          }),
        }),
      );
    });
  });

  it('prevents stale responses from overwriting current folder state (race condition guard)', async () => {
    let resolveFolderA: ((val: unknown) => void) | null = null;

    const mockFetch = vi.fn().mockImplementation((url: string, opts) => {
      if (url.includes('folderId=f-a')) {
        return new Promise((resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The user aborted a request.', 'AbortError'));
          });
          resolveFolderA = () =>
            resolve({
              ok: true,
              status: 200,
              headers: new Headers(),
              json: async () => ({
                accountId: 'acc-1',
                scope: { kind: 'folder', folderId: 'f-a' },
                items: [{ ...mockMessages[0], id: 'msg-a', subject: 'Folder A Msg' }],
                nextCursor: null,
              }),
            });
        });
      }

      if (url.includes('folderId=f-b')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            accountId: 'acc-1',
            scope: { kind: 'folder', folderId: 'f-b' },
            items: [{ ...mockMessages[0], id: 'msg-b', subject: 'Folder B Msg' }],
            nextCursor: null,
          }),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ items: [] }),
      });
    });

    const client = new ApiClient({ baseUrl: 'http://test/api', fetchFn: mockFetch });

    function TestFolderSwitcher({ activeFolder }: { activeFolder: string }) {
      const res = useMessages({
        accountId: 'acc-1',
        folder: activeFolder,
        filter: EMPTY_FILTER,
      });

      if (res.status !== 'ready') return <div>Loading {activeFolder}</div>;
      return <div data-testid="active-messages">{res.data.items.map((m) => m.subject).join(',')}</div>;
    }

    const { rerender } = render(
      <ApiMailDataProvider client={client}>
        <TestFolderSwitcher activeFolder="f-a" />
      </ApiMailDataProvider>,
    );

    expect(screen.getByText('Loading f-a')).toBeInTheDocument();

    // User switches to folder B before folder A response arrives
    rerender(
      <ApiMailDataProvider client={client}>
        <TestFolderSwitcher activeFolder="f-b" />
      </ApiMailDataProvider>,
    );

    // Folder B responds immediately
    await waitFor(() => {
      expect(screen.getByTestId('active-messages')).toHaveTextContent('Folder B Msg');
    });

    // Folder A's delayed response finally arrives
    if (resolveFolderA) {
      (resolveFolderA as () => void)();
    }

    // Must still show Folder B Msg, NOT Folder A Msg
    expect(screen.getByTestId('active-messages')).toHaveTextContent('Folder B Msg');
    expect(screen.getByTestId('active-messages')).not.toHaveTextContent('Folder A Msg');
  });
});

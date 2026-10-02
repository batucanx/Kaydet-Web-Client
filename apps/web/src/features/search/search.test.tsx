import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AccountDTO, FolderDTO, SearchPageDTO, SearchResultDTO } from '@kaydet/domain';
import * as searchApi from '../../data/api/search';
import { MailDataProvider } from '../../data/MailDataContext';
import type { MailDataSource } from '../../data/types';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { SearchPage } from './SearchPage';

const mockAccount: AccountDTO = {
  id: 'acc-1',
  email: 'user@example.com',
  displayName: 'User Example',
  supportsServerLabels: true,
  sync: { status: 'idle', lastSyncAt: null },
};

const mockAccount2: AccountDTO = {
  id: 'acc-2',
  email: 'work@example.com',
  displayName: 'Work Account',
  supportsServerLabels: false,
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
    unreadCount: 1,
    totalCount: 5,
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
    totalCount: 2,
  },
];

const mockResult: SearchResultDTO = {
  message: {
    id: 'msg-101',
    accountId: 'acc-1',
    folderId: 'f-inbox',
    threadId: 't-101',
    from: { name: 'Ahmet Yılmaz', email: 'ahmet@firma.com' },
    to: [{ name: 'User', email: 'user@example.com' }],
    subject: 'Eylül Faturası ve Rapor',
    preview: 'Sayın Yetkili, Eylül ayı faturası ektedir.',
    date: '2026-09-30T10:00:00.000Z',
    seen: false,
    pinned: false,
    answered: false,
    forwarded: false,
    draft: false,
    hasAttachments: true,
    labels: [],
    outbox: { state: 'none' },
  },
  folder: {
    id: 'f-inbox',
    name: 'Gelen Kutusu',
    role: 'inbox',
  },
};

function createMockDataSource(overrides: Partial<MailDataSource> = {}): MailDataSource {
  return {
    useAccounts: () => ({ status: 'ready', data: [mockAccount, mockAccount2] }),
    useFolders: () => ({ status: 'ready', data: mockFolders }),
    useLabels: () => ({ status: 'ready', data: [] }),
    usePinnedCount: () => 0,
    usePinned: () => [],
    useMessages: () => ({ status: 'ready', data: { items: [], hasMore: false, isLoadingMore: false, loadMore: () => {} } }),
    useMessageDetail: () => ({
      status: 'ready',
      data: {
        ...mockResult.message,
        cc: [],
        bcc: [],
        body: { text: 'Detaylı metin', html: null, sanitized: true },
        attachments: [],
      },
    }),
    actions: {
      setSeen: vi.fn(),
      setPinned: vi.fn(),
      archive: vi.fn(),
      remove: vi.fn(),
      deletePermanently: vi.fn(),
      restoreToInbox: vi.fn(),
      markSpam: vi.fn(),
      moveToFolder: vi.fn(),
      applyLabel: vi.fn(),
    },
    ...overrides,
  };
}

function renderSearchPage(initialEntries = ['/a/acc-1/search?q=fatura'], ds = createMockDataSource()) {
  return render(
    <ThemeProvider>
      <MailDataProvider source={ds}>
        <MemoryRouter initialEntries={initialEntries}>
          <Routes>
            <Route path="/a/:accountId/search/*" element={<SearchPage />} />
          </Routes>
        </MemoryRouter>
      </MailDataProvider>
    </ThemeProvider>,
  );
}

describe('SearchPage (Phase 11)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders idle prompt when search query is empty or whitespace', async () => {
    const searchSpy = vi.spyOn(searchApi, 'searchMessages');
    renderSearchPage(['/a/acc-1/search']);

    expect(screen.getByText('Arama yapın')).toBeInTheDocument();
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it('executes search and displays result list with folder badge and message details', async () => {
    vi.spyOn(searchApi, 'searchMessages').mockResolvedValueOnce({
      items: [mockResult],
      nextCursor: null,
    });

    renderSearchPage(['/a/acc-1/search?q=fatura']);

    await waitFor(() => {
      expect(screen.getByText('Eylül Faturası ve Rapor')).toBeInTheDocument();
    });

    expect(screen.getByText('Ahmet Yılmaz')).toBeInTheDocument();
    expect(screen.getByText('Gelen Kutusu')).toBeInTheDocument();
    expect(screen.getByText('1 sonuç')).toBeInTheDocument();
  });

  it('renders no-results empty state when search returns empty', async () => {
    vi.spyOn(searchApi, 'searchMessages').mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    });

    renderSearchPage(['/a/acc-1/search?q=bulunamayan']);

    await waitFor(() => {
      expect(screen.getByText('Sonuç bulunamadı')).toBeInTheDocument();
    });
  });

  it('renders error state and allows retry on network failure', async () => {
    const user = userEvent.setup();
    const searchSpy = vi
      .spyOn(searchApi, 'searchMessages')
      .mockRejectedValueOnce(new Error('Sunucu hatası'))
      .mockResolvedValueOnce({ items: [mockResult], nextCursor: null });

    renderSearchPage(['/a/acc-1/search?q=hata']);

    await waitFor(() => {
      expect(screen.getByText('Arama yapılamadı')).toBeInTheDocument();
      expect(screen.getByText('Sunucu hatası')).toBeInTheDocument();
    });

    const retryBtn = screen.getByRole('button', { name: 'Tekrar dene' });
    await user.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByText('Eylül Faturası ve Rapor')).toBeInTheDocument();
    });
    expect(searchSpy).toHaveBeenCalledTimes(2);
  });

  it('protects against request race conditions (stale older response does not overwrite newer one)', async () => {
    const user = userEvent.setup();
    let resolveFirst!: (value: SearchPageDTO) => void;
    const firstPromise = new Promise<SearchPageDTO>((resolve) => {
      resolveFirst = resolve;
    });

    const secondResult: SearchResultDTO = {
      ...mockResult,
      message: { ...mockResult.message, id: 'msg-newer', subject: 'Daha Yeni Arama Sonucu' },
    };

    vi.spyOn(searchApi, 'searchMessages').mockImplementation((_client, params) => {
      if (params.q === 'ilk') return firstPromise;
      if (params.q === 'ikinci') return Promise.resolve({ items: [secondResult], nextCursor: null });
      return Promise.resolve({ items: [], nextCursor: null });
    });

    renderSearchPage(['/a/acc-1/search?q=ilk']);

    // Trigger second search query by typing in the search box
    const inputs = screen.getAllByPlaceholderText('Ara');
    const input = inputs[0];
    await user.clear(input);
    await user.type(input, 'ikinci{enter}');

    // Second immediately shows
    await waitFor(() => {
      expect(screen.getByText('Daha Yeni Arama Sonucu')).toBeInTheDocument();
    });

    // Now resolve first late
    resolveFirst({ items: [mockResult], nextCursor: null });

    // The newer result must NOT be overwritten!
    expect(screen.getByText('Daha Yeni Arama Sonucu')).toBeInTheDocument();
    expect(screen.queryByText('Eylül Faturası ve Rapor')).not.toBeInTheDocument();
  });

  it('supports account scope toggle between active account and all accounts', async () => {
    const user = userEvent.setup();
    const searchSpy = vi.spyOn(searchApi, 'searchMessages').mockResolvedValue({
      items: [mockResult],
      nextCursor: null,
    });

    renderSearchPage(['/a/acc-1/search?q=toplantı']);

    await waitFor(() => {
      expect(screen.getByText('Bu hesap')).toBeInTheDocument();
    });

    const allAccountsBtn = screen.getByRole('radio', { name: 'Tüm hesaplar' });
    await user.click(allAccountsBtn);

    await waitFor(() => {
      expect(searchSpy).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          accounts: { kind: 'all' },
        }),
        expect.any(AbortSignal),
      );
    });
  });

  it('supports filter toggle for attachments and clearing filters', async () => {
    const user = userEvent.setup();
    const searchSpy = vi.spyOn(searchApi, 'searchMessages').mockResolvedValue({
      items: [mockResult],
      nextCursor: null,
    });

    renderSearchPage(['/a/acc-1/search?q=fatura']);

    await waitFor(() => {
      expect(screen.getByText('Ekli olanlar')).toBeInTheDocument();
    });

    const attachmentsChip = screen.getByRole('button', { name: 'Ekli olanlar' });
    await user.click(attachmentsChip);

    await waitFor(() => {
      expect(searchSpy).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          filters: expect.objectContaining({ attachmentsOnly: true }),
        }),
        expect.any(AbortSignal),
      );
    });

    // Filter badge 1 should appear
    expect(screen.getByText('1')).toBeInTheDocument();

    // Click clear filters
    const clearBtn = screen.getByRole('button', { name: 'Filtreleri temizle' });
    await user.click(clearBtn);

    await waitFor(() => {
      expect(screen.queryByText('1')).not.toBeInTheDocument();
    });
  });

  it('optimistically toggles pin and seen states on search results', async () => {
    const user = userEvent.setup();
    const ds = createMockDataSource();
    vi.spyOn(searchApi, 'searchMessages').mockResolvedValueOnce({
      items: [mockResult],
      nextCursor: null,
    });

    renderSearchPage(['/a/acc-1/search?q=fatura'], ds);

    await waitFor(() => {
      expect(screen.getByText('Eylül Faturası ve Rapor')).toBeInTheDocument();
    });

    // Toggle Pin
    const pinBtn = screen.getByLabelText('Sabitle');
    await user.click(pinBtn);
    expect(ds.actions.setPinned).toHaveBeenCalledWith(['msg-101'], true);

    // Toggle Seen
    const seenBtn = screen.getByLabelText('Okundu olarak işaretle');
    await user.click(seenBtn);
    expect(ds.actions.setSeen).toHaveBeenCalledWith(['msg-101'], true);
  });

  it('renders MailReader when active message id is present in the route', async () => {
    vi.spyOn(searchApi, 'searchMessages').mockResolvedValueOnce({
      items: [mockResult],
      nextCursor: null,
    });

    renderSearchPage(['/a/acc-1/search/m/msg-101?q=fatura']);

    await waitFor(() => {
      expect(screen.getByText('Eylül Faturası ve Rapor')).toBeInTheDocument();
    });

    // Both the list pane and reader pane should be present
    expect(screen.getByLabelText('Arama sonuçları')).toBeInTheDocument();
    expect(screen.getByLabelText('İleti okuyucu')).toBeInTheDocument();
  });
});

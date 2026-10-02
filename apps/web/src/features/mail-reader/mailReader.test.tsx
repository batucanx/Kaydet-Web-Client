import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { MailDataSource, MessageDTO } from '../../data/types';
import { MailDataProvider } from '../../data/MailDataContext';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { MailReader } from './MailReader';
import { EmailDocument } from './EmailDocument';
import { MailAttachments } from './MailAttachments';

const SAMPLE_MESSAGE: MessageDTO = {
  id: 'msg-1',
  accountId: 'acc-1',
  folderId: 'fld-inbox',
  threadId: 'th-1',
  from: { name: 'Ahmet Yılmaz', email: 'ahmet@sirket.example' },
  to: [
    { name: 'Mehmet Öz', email: 'mehmet@sirket.example' },
    { name: 'Ayşe Demir', email: 'ayse@sirket.example' },
  ],
  cc: [{ name: 'Müdür Bey', email: 'mudur@sirket.example' }],
  bcc: [],
  subject: 'Önemli Proje Raporu',
  preview: 'Rapor detayları ekte sunulmuştur.',
  date: '2026-09-14T10:54:00.000Z',
  seen: false,
  pinned: false,
  answered: false,
  forwarded: false,
  draft: false,
  hasAttachments: true,
  labels: ['İş'],
  outbox: { state: 'none' },
  body: {
    text: 'Merhaba Mehmet,\n\nRapor detayları ekte sunulmuştur.\nSaygılarımla,\nAhmet',
    html: {
      content: '<p>Merhaba Mehmet,</p><p>Rapor detayları ekte sunulmuştur.</p>',
      sanitized: true,
    },
  },
  attachments: [
    {
      id: 'att-1',
      messageId: 'msg-1',
      fileName: 'rapor.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024 * 1024 * 2.5,
      isInline: false,
    },
  ],
};

function createMockSource(msg: MessageDTO | null = SAMPLE_MESSAGE) {
  const actions = {
    setSeen: vi.fn(),
    setPinned: vi.fn(),
    archive: vi.fn(() => ({ undo: () => Promise.resolve(true) })),
    remove: vi.fn(() => ({ undo: () => Promise.resolve(true) })),
    deletePermanently: vi.fn(),
    restoreToInbox: vi.fn(() => ({ undo: () => Promise.resolve(true) })),
    markSpam: vi.fn(() => ({ undo: () => Promise.resolve(true) })),
    moveToFolder: vi.fn(() => ({ undo: () => Promise.resolve(true) })),
    applyLabel: vi.fn(),
  };

  const source = {
    useAccounts: () => ({ status: 'ready' as const, data: [] }),
    useFolders: () => ({ status: 'ready' as const, data: [] }),
    useLabels: () => ({ status: 'ready' as const, data: [] }),
    usePinnedCount: () => 0,
    usePinned: () => [],
    useMessages: () => ({
      status: 'ready' as const,
      data: { items: [], hasMore: false, isLoadingMore: false, loadMore: () => {} },
    }),
    useMessageDetail: () =>
      msg ? { status: 'ready' as const, data: msg } : { status: 'error' as const, message: 'İleti bulunamadı.' },
    actions,
  };

  return { source, actions };
}

function renderReader(source: MailDataSource, accountId = 'acc-1', messageId = 'msg-1', onBack = () => {}) {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <MailDataProvider source={source}>
          <MailReader accountId={accountId} messageId={messageId} onBack={onBack} />
        </MailDataProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('MailReader', () => {
  it('renders the sender, subject, date, recipient summary and body correctly', async () => {
    const { source } = createMockSource();
    renderReader(source);

    // Subject
    expect(screen.getByRole('heading', { level: 1, name: 'Önemli Proje Raporu' })).toBeInTheDocument();

    // Sender
    expect(screen.getByText('Ahmet Yılmaz')).toBeInTheDocument();
    expect(screen.getByText('<ahmet@sirket.example>')).toBeInTheDocument();

    // Recipient summary
    expect(screen.getByText('Mehmet Öz +1')).toBeInTheDocument();

    // Sandboxed iframe body
    const iframe = screen.getByTitle('Önemli Proje Raporu');
    expect(iframe).toBeInTheDocument();
    expect(iframe).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    expect(iframe).toHaveAttribute('srcdoc');
    expect(iframe.getAttribute('srcdoc')).toContain('Merhaba Mehmet');
  });

  it('expands recipient details to show To and CC lists when clicked', async () => {
    const user = userEvent.setup();
    const { source } = createMockSource();
    renderReader(source);

    const toggle = screen.getByRole('button', { name: /Mehmet Öz \+1/ });
    await user.click(toggle);

    const details = screen.getByRole('region', { name: 'Ayrıntılı alıcı bilgileri' });
    expect(details).toBeInTheDocument();
    expect(details).toHaveTextContent('mehmet@sirket.example');
    expect(details).toHaveTextContent('ayse@sirket.example');
    expect(details).toHaveTextContent('mudur@sirket.example');
  });

  it('renders attachments with type badges and formatted sizes', () => {
    render(<MailAttachments messageId="msg-1" attachments={SAMPLE_MESSAGE.attachments} />);

    const link = screen.getByRole('link', { name: /rapor\.pdf/ });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/api/messages/msg-1/attachments/att-1?download=1');
    expect(link).toHaveTextContent('PDF');
    expect(link).toHaveTextContent('2,5 MB');
  });

  it('automatically marks unread message as seen upon opening', async () => {
    const { source, actions } = createMockSource({ ...SAMPLE_MESSAGE, seen: false });
    renderReader(source);

    await waitFor(() => {
      expect(actions.setSeen).toHaveBeenCalledWith(['msg-1'], true);
    });
  });

  it('triggers action dispatches for pin, unread, archive and delete', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const { source, actions } = createMockSource();
    renderReader(source, 'acc-1', 'msg-1', onBack);

    // Pin
    const pinBtn = screen.getByRole('button', { name: 'Sabitle' });
    await user.click(pinBtn);
    expect(actions.setPinned).toHaveBeenCalledWith(['msg-1'], true);

    // Mark unread
    const unreadBtn = screen.getByRole('button', { name: 'Okundu olarak işaretle' });
    await user.click(unreadBtn);
    expect(actions.setSeen).toHaveBeenCalledWith(['msg-1'], true);

    // Archive
    const archiveBtn = screen.getByRole('button', { name: 'Arşivle' });
    await user.click(archiveBtn);
    expect(actions.archive).toHaveBeenCalledWith(['msg-1']);
    expect(onBack).toHaveBeenCalled();

    // Delete
    const deleteBtn = screen.getByRole('button', { name: 'Sil' });
    await user.click(deleteBtn);
    expect(actions.remove).toHaveBeenCalledWith(['msg-1']);
  });

  it('renders plain-text fallback when html is null or unsanitized', () => {
    render(
      <ThemeProvider>
        <EmailDocument
          html="<script>alert(1)</script>"
          isSanitized={false}
          plainTextFallback="Düz metin içeriği"
        />
      </ThemeProvider>,
    );

    expect(screen.queryByTitle('E-posta içeriği')).not.toBeInTheDocument();
    expect(screen.getByText('Düz metin içeriği')).toBeInTheDocument();
  });
});

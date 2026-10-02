import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AccountDTO } from '@kaydet/domain';
import { AccountSetupForm } from './AccountSetupForm';
import { AddAccountModal } from './AddAccountModal';
import { InitialAccountSetupPage } from './InitialAccountSetupPage';
import * as accountsApi from '../../data/api/accounts';
import { ApiClientError } from '../../data/api/errors';
import { MailDataProvider } from '../../data/MailDataContext';
import type { MailDataSource } from '../../data/types';

const mockDataSource = (reloadAccounts = vi.fn()): MailDataSource => ({
  useAccounts: () => ({ status: 'ready', data: [] }),
  reloadAccounts,
  useFolders: () => ({ status: 'ready', data: [] }),
  useLabels: () => ({ status: 'ready', data: [] }),
  usePinnedCount: () => 0,
  usePinned: () => [],
  useMessages: () => ({ status: 'ready', data: { items: [], hasMore: false, isLoadingMore: false, loadMore: () => {} } }),
  useMessageDetail: () => ({ status: 'loading' }),
  actions: {
    setSeen: () => {},
    setPinned: () => {},
    archive: () => null,
    remove: () => null,
    deletePermanently: () => {},
    restoreToInbox: () => null,
    markSpam: () => null,
    moveToFolder: () => null,
    applyLabel: () => {},
  },
});

describe('Shared Account Setup Form (Parity Fix)', () => {
  it('1. renders "Sunucu ayarları" section toggle and core account fields', () => {
    render(
      <MemoryRouter>
        <MailDataProvider source={mockDataSource()}>
          <AccountSetupForm />
        </MailDataProvider>
      </MemoryRouter>,
    );

    expect(screen.getByLabelText(/E-posta adresi/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Ad Soyad/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Şifre$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sunucu ayarları/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hesap Ekle' })).toBeInTheDocument();
  });

  it('2. collapses and expands server settings on click', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MailDataProvider source={mockDataSource()}>
          <AccountSetupForm />
        </MailDataProvider>
      </MemoryRouter>,
    );

    const toggle = screen.getByRole('button', { name: /Sunucu ayarları/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Gelen sunucu — IMAP')).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Gelen sunucu — IMAP')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Kullanıcı adı/i)).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Gelen sunucu — IMAP')).not.toBeInTheDocument();
  });

  it('3 & 4. renders all IMAP and SMTP configuration fields when expanded', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <MailDataProvider source={mockDataSource()}>
          <AccountSetupForm />
        </MailDataProvider>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /Sunucu ayarları/i }));

    // IMAP fields
    expect(container.querySelector('#add-account-imap-host')).toBeInTheDocument();
    expect(container.querySelector('#add-account-imap-port')).toBeInTheDocument();
    expect(container.querySelector('#add-account-imap-security')).toBeInTheDocument();

    // SMTP fields
    expect(container.querySelector('#add-account-smtp-host')).toBeInTheDocument();
    expect(container.querySelector('#add-account-smtp-port')).toBeInTheDocument();
    expect(container.querySelector('#add-account-smtp-security')).toBeInTheDocument();
  });

  it('5. autofills IMAP and SMTP hosts from email domain', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <MailDataProvider source={mockDataSource()}>
          <AccountSetupForm />
        </MailDataProvider>
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText(/E-posta adresi/i), 'ahmet@sirket.com.tr');
    await user.click(screen.getByRole('button', { name: /Sunucu ayarları/i }));

    expect(container.querySelector('#add-account-imap-host')).toHaveValue('mail.sirket.com.tr');
    expect(container.querySelector('#add-account-smtp-host')).toHaveValue('mail.sirket.com.tr');
  });

  it('6. updates port defaults when switching IMAP and SMTP security modes', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <MailDataProvider source={mockDataSource()}>
          <AccountSetupForm />
        </MailDataProvider>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /Sunucu ayarları/i }));

    const imapPort = container.querySelector('#add-account-imap-port') as HTMLInputElement;
    const imapSecurity = container.querySelector('#add-account-imap-security') as HTMLSelectElement;
    expect(imapPort.value).toBe('993');
    await user.selectOptions(imapSecurity, 'startTls');
    expect(imapPort.value).toBe('143');

    const smtpPort = container.querySelector('#add-account-smtp-port') as HTMLInputElement;
    const smtpSecurity = container.querySelector('#add-account-smtp-security') as HTMLSelectElement;
    expect(smtpPort.value).toBe('465');
    await user.selectOptions(smtpSecurity, 'startTls');
    expect(smtpPort.value).toBe('587');
  });

  it('7. toggles password visibility with eye button', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MailDataProvider source={mockDataSource()}>
          <AccountSetupForm />
        </MailDataProvider>
      </MemoryRouter>,
    );

    const passwordInput = screen.getByLabelText(/^Şifre$/);
    expect(passwordInput).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: 'Şifreyi göster' }));
    expect(passwordInput).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'Şifreyi gizle' }));
    expect(passwordInput).toHaveAttribute('type', 'password');
  });

  it('8. automatically expands server settings and shows alert on IMAP error', async () => {
    const user = userEvent.setup();
    const apiError = new ApiClientError({
      code: 'provider_unreachable',
      kind: 'provider',
      message: 'IMAP sunucusuna bağlanılamadı.',
      retryable: true,
      fields: [{ field: 'imap', reason: 'provider_unreachable' }],
    });
    vi.spyOn(accountsApi, 'createAccount').mockRejectedValueOnce(apiError);

    render(
      <MemoryRouter>
        <MailDataProvider source={mockDataSource()}>
          <AccountSetupForm />
        </MailDataProvider>
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText(/E-posta adresi/i), 'user@test.com');
    await user.type(screen.getByLabelText(/^Şifre$/), 'secret123');
    await user.click(screen.getByRole('button', { name: 'Hesap Ekle' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Gelen sunucu \(IMAP\): IMAP sunucusuna bağlanılamadı/i);
    });

    // Server settings should be auto-expanded
    expect(screen.getByText('Gelen sunucu — IMAP')).toBeInTheDocument();
  });

  it('9. automatically expands server settings and shows alert on SMTP error', async () => {
    const user = userEvent.setup();
    const apiError = new ApiClientError({
      code: 'mail_credentials_rejected',
      kind: 'authentication',
      message: 'SMTP kimlik doğrulaması başarısız.',
      retryable: false,
      fields: [{ field: 'smtp', reason: 'mail_credentials_rejected' }],
    });
    vi.spyOn(accountsApi, 'createAccount').mockRejectedValueOnce(apiError);

    render(
      <MemoryRouter>
        <MailDataProvider source={mockDataSource()}>
          <AccountSetupForm />
        </MailDataProvider>
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText(/E-posta adresi/i), 'user@test.com');
    await user.type(screen.getByLabelText(/^Şifre$/), 'secret123');
    await user.click(screen.getByRole('button', { name: 'Hesap Ekle' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Giden sunucu \(SMTP\): SMTP kimlik doğrulaması başarısız/i);
    });

    expect(screen.getByText('Gelen sunucu — IMAP')).toBeInTheDocument();
  });

  it('10. validates fields and creates account with typed payload', async () => {
    const user = userEvent.setup();
    const reloadMock = vi.fn().mockResolvedValue(undefined);
    const successMock = vi.fn();

    const createdAccount: AccountDTO = {
      id: 'acc-new-777',
      email: 'test@example.com',
      displayName: 'Test User',
      supportsServerLabels: null,
      sync: { status: 'idle', lastSyncAt: null },
    };
    const createSpy = vi.spyOn(accountsApi, 'createAccount').mockResolvedValueOnce(createdAccount);

    render(
      <MemoryRouter>
        <MailDataProvider source={mockDataSource(reloadMock)}>
          <AccountSetupForm onSuccess={successMock} />
        </MailDataProvider>
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText(/E-posta adresi/i), 'test@example.com');
    await user.type(screen.getByLabelText(/Ad Soyad/i), 'Test User');
    await user.type(screen.getByLabelText(/^Şifre$/), 'strongpass');

    await user.click(screen.getByRole('button', { name: 'Hesap Ekle' }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(undefined, {
        email: 'test@example.com',
        displayName: 'Test User',
        username: 'test@example.com',
        password: 'strongpass',
        imap: { host: 'mail.example.com', port: 993, security: 'ssl' },
        smtp: { host: 'mail.example.com', port: 465, security: 'ssl' },
      });
    });

    expect(reloadMock).toHaveBeenCalled();
    expect(successMock).toHaveBeenCalledWith(createdAccount);
  });
});

describe('Initial Account Setup & Add Account Modal Integration', () => {
  it('renders InitialAccountSetupPage with header and shared form', () => {
    render(
      <MemoryRouter>
        <MailDataProvider source={mockDataSource()}>
          <InitialAccountSetupPage />
        </MailDataProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Hesap Ekle' })).toBeInTheDocument();
    expect(screen.getByLabelText(/E-posta adresi/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sunucu ayarları/i })).toBeInTheDocument();
  });

  it('renders AddAccountModal with modal dialog and shared form', () => {
    const closeMock = vi.fn();
    render(
      <MemoryRouter>
        <MailDataProvider source={mockDataSource()}>
          <AddAccountModal open={true} onClose={closeMock} />
        </MailDataProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Hesap ekle' })).toBeInTheDocument();
    expect(screen.getByLabelText(/E-posta adresi/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kapat' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sunucu ayarları/i })).toBeInTheDocument();
  });
});

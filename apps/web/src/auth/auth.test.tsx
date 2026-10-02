import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
import { LoginPage } from './LoginPage';
import { ApiClient } from '../data/api/client';
import { createApiError } from '@kaydet/domain';

function TestAuthConsumer() {
  const { status, user, logout } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.id ?? 'none'}</span>
      <button onClick={logout}>Çıkış yap</button>
    </div>
  );
}

describe('AuthContext and LoginPage', () => {
  it('bootstraps active session', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        authenticated: true,
        user: { id: 'u1' },
        expiresAt: '2026-10-10T00:00:00.000Z',
      }),
    });

    const client = new ApiClient({ baseUrl: 'http://test/api', fetchFn: mockFetch });

    render(
      <AuthProvider client={client}>
        <TestAuthConsumer />
      </AuthProvider>,
    );

    expect(screen.getByTestId('status').textContent).toBe('loading');

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
      expect(screen.getByTestId('user').textContent).toBe('u1');
    });
  });

  it('bootstraps unauthenticated state when getSession returns authenticated: false', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        authenticated: false,
        user: null,
      }),
    });

    const client = new ApiClient({ baseUrl: 'http://test/api', fetchFn: mockFetch });

    render(
      <AuthProvider client={client}>
        <TestAuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
      expect(screen.getByTestId('user').textContent).toBe('none');
    });
  });

  it('handles login form submit and displays error on failure', async () => {
    const user = userEvent.setup();
    const mockFetch = vi
      .fn()
      // Initial getSession -> unauthenticated
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ authenticated: false, user: null }),
      })
      // Failed login attempt
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers(),
        json: async () => ({
          error: createApiError('invalid_credentials'),
        }),
      });

    const client = new ApiClient({ baseUrl: 'http://test/api', fetchFn: mockFetch });

    render(
      <AuthProvider client={client}>
        <LoginPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/E-posta adresi/i)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/Kullanıcı adı/i)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/E-posta adresi/i), 'wrong@example.com');
    await user.type(screen.getByLabelText(/^Şifre$/), 'wrong-pass');
    await user.click(screen.getByRole('button', { name: /Giriş yap/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Giriş bilgileri hatalı.');
    });
    // Server settings are part of the sign-in form and open on failure
    expect(screen.getByLabelText('Sunucu', { selector: '#login-imap-host' })).toHaveValue('mail.example.com');
  });

  it('signs in with the mailbox: posts address, password and server settings to /session/mailbox', async () => {
    const user = userEvent.setup();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ authenticated: false, user: null }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers(),
        json: async () => ({ authenticated: true, user: { id: 'u9' }, expiresAt: '2026-10-10T00:00:00.000Z' }),
      });
    const client = new ApiClient({ baseUrl: 'http://test/api', fetchFn: mockFetch });

    render(
      <AuthProvider client={client}>
        <LoginPage />
        <TestAuthConsumer />
      </AuthProvider>,
    );

    await user.type(await screen.findByLabelText(/E-posta adresi/i), 'me@example.com');
    await user.type(screen.getByLabelText(/^Şifre$/), 'secret');
    await user.click(screen.getByRole('button', { name: /Giriş yap/i }));

    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('u9'));
    const [url, init] = mockFetch.mock.calls[1] as [string, { body: string }];
    expect(url).toBe('http://test/api/session/mailbox');
    expect(JSON.parse(init.body)).toEqual({
      email: 'me@example.com',
      password: 'secret',
      imap: { host: 'mail.example.com', port: 993, security: 'ssl' },
      smtp: { host: 'mail.example.com', port: 465, security: 'ssl' },
    });
  });

  it('handles logout and transitions to unauthenticated', async () => {
    const user = userEvent.setup();
    const mockFetch = vi
      .fn()
      // getSession
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ authenticated: true, user: { id: 'u1' } }),
      })
      // DELETE /session
      .mockResolvedValueOnce({
        ok: true,
        status: 204,
        headers: new Headers(),
      });

    const client = new ApiClient({ baseUrl: 'http://test/api', fetchFn: mockFetch });

    render(
      <AuthProvider client={client}>
        <TestAuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });

    await user.click(screen.getByRole('button', { name: /Çıkış yap/i }));

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
      expect(screen.getByTestId('user').textContent).toBe('none');
    });
  });
});

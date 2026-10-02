import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { MockMailDataProvider } from '../data/mock/MockMailDataProvider';
import { ThemeProvider } from '../theme/ThemeProvider';
import { NoticeProvider } from '../ui/Notice';
import { AppRoutes } from './routes';

function renderApp(path = '/') {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <NoticeProvider>
          <MockMailDataProvider>
            <AppRoutes />
          </MockMailDataProvider>
        </NoticeProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

// jsdom's default window is 1024 px wide → "laptop" shell mode (full sidebar, wide rows).
describe('application shell', () => {
  it('lands on the first account Inbox with Kaydet terminology and landmarks', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { level: 1, name: 'Gelen Kutusu' })).toBeInTheDocument();

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('search')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Klasörler' });
    for (const label of ['Gelen Kutusu', 'Gönderilenler', 'Arşiv', 'Taslaklar', 'Çöp Kutusu', 'İstenmeyen', 'Sabitlenenler']) {
      expect(within(nav).getByRole('link', { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
    // Favorite folders and pinned messages are distinct concepts.
    expect(within(nav).getByRole('heading', { name: 'Sık Kullanılanlar' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: /Yeni ileti/ })).toBeInTheDocument();
  });

  it('marks the current folder with aria-current and switches folder', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { level: 1, name: 'Gelen Kutusu' });
    const nav = screen.getByRole('navigation', { name: 'Klasörler' });
    expect(within(nav).getByRole('link', { name: /^Gelen Kutusu/ })).toHaveAttribute('aria-current', 'page');

    await user.click(within(nav).getByRole('link', { name: /^Gönderilenler/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Gönderilenler' })).toBeInTheDocument();
  });

  it('exposes only the filters mobile supports, as toggles', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { level: 1, name: 'Gelen Kutusu' });
    const group = screen.getByRole('group', { name: 'Filtreler' });
    for (const name of ['Tümü', 'Okunmamış', 'Sabitlenmiş', 'Ek dosyalı']) {
      expect(within(group).getByRole('button', { name })).toBeInTheDocument();
    }
    const unread = within(group).getByRole('button', { name: 'Okunmamış' });
    expect(unread).toHaveAttribute('aria-pressed', 'false');
    await user.click(unread);
    expect(unread).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Tümü' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(group).getByRole('button', { name: 'Filtreyi temizle' })).toBeInTheDocument();
  });

  it('selecting rows reveals the action bar; archive is undoable', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { level: 1, name: 'Gelen Kutusu' });

    const checkboxes = await screen.findAllByRole('checkbox', { name: /^Seç:/ });
    // A regular (unpinned) row: pinned messages legitimately stay in the Sabitlenenler section.
    const target = checkboxes.find((c) => !c.closest('[data-row-id]')?.hasAttribute('data-pinned'));
    if (!target) throw new Error('expected an unpinned row');
    const rowId = target.closest('[data-row-id]')?.getAttribute('data-row-id');
    await user.click(target);

    const toolbar = screen.getByRole('toolbar', { name: 'Liste eylemleri' });
    expect(within(toolbar).getByText('1 seçili')).toBeInTheDocument();

    await user.click(within(toolbar).getByRole('button', { name: /Arşivle/ }));
    expect(await screen.findByText('İleti arşivlendi')).toBeInTheDocument();
    expect(document.querySelector(`[data-row-id="${rowId}"]`)).toBeNull();
    expect(within(toolbar).queryByText('1 seçili')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Geri al' }));
    await waitFor(() => expect(document.querySelector(`[data-row-id="${rowId}"]`)).not.toBeNull());
  });

  it('unread rows are announced, not just colored', async () => {
    renderApp();
    await screen.findByRole('heading', { level: 1, name: 'Gelen Kutusu' });
    const unreadLinks = await screen.findAllByRole('link', { name: /^Okunmamış\./ });
    expect(unreadLinks.length).toBeGreaterThan(0);
  });

  it('keeps exactly one row link in the tab order (roving tabindex)', async () => {
    renderApp();
    await screen.findAllByRole('link', { name: /\d{2}:\d{2}|Dün|\d{4}/ });
    const stops = document.querySelectorAll('[data-row-link]:not([tabindex="-1"])');
    expect(stops).toHaveLength(1);
  });

  it('switches account through the URL model', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { level: 1, name: 'Gelen Kutusu' });
    await user.click(screen.getByRole('button', { name: /Hesap değiştir/ }));
    await user.click(await screen.findByRole('menuitem', { name: /ayse@ornek\.example/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Hesap: ayse@ornek\.example/ })).toBeInTheDocument());
  });

  it('shows the empty state with mobile copy', async () => {
    window.history.pushState({}, '', '/?mock=empty');
    renderApp();
    expect(await screen.findByText('Bu klasör boş')).toBeInTheDocument();
    expect(screen.getByText('Yeni iletiler geldiğinde burada görünecek.')).toBeInTheDocument();
    window.history.pushState({}, '', '/');
  });
});

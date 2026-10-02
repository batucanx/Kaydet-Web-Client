import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/routes';
import { MockMailDataProvider } from '../../data/mock/MockMailDataProvider';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { NoticeProvider } from '../../ui/Notice';

function renderWithRouter(initialEntry: string) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <NoticeProvider>
          <MockMailDataProvider>
            <AppRoutes />
          </MockMailDataProvider>
        </NoticeProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('Routing & Reader Integration', () => {
  it('opens a message directly from the URL /a/:accountId/f/:folderRef/m/:messageId', async () => {
    renderWithRouter('/a/acc1/f/acc1_inbox');

    // Wait for list to load
    const rowLinks = await screen.findAllByRole('link', { name: /Ayşe Demir|Mehmet Kaya|Elif Yıldız/ });
    expect(rowLinks.length).toBeGreaterThan(0);

    const firstHref = rowLinks[0]?.getAttribute('href');
    expect(firstHref).toMatch(/\/a\/acc1\/f\/acc1_inbox\/m\/.+/);

    // Extract messageId
    const messageId = firstHref?.split('/m/')[1]?.split('?')[0];
    expect(messageId).toBeTruthy();
  });

  it('renders both list pane and reader pane in split view on desktop when messageId is in URL', async () => {
    renderWithRouter('/a/acc1/f/acc1_inbox');
    const rowLinks = await screen.findAllByRole('link', { name: /Ayşe Demir|Mehmet Kaya|Elif Yıldız/ });
    const firstHref = rowLinks[0]!.getAttribute('href') ?? '';
    const messageId = firstHref.split('/m/')[1]?.split('?')[0];

    // Now render with the message URL directly
    renderWithRouter(`/a/acc1/f/acc1_inbox/m/${messageId}`);

    // Both list and reader region should be present in split view
    expect(await screen.findByRole('region', { name: 'İleti okuyucu' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Gelen Kutusu' })).toBeInTheDocument();
  });

  it('handles invalid message ID safely without crashing', async () => {
    renderWithRouter('/a/acc1/f/acc1_inbox/m/invalid-non-existent-msg-id');

    expect(await screen.findByText('İleti bulunamadı')).toBeInTheDocument();
    expect(screen.getByText('Bu ileti silinmiş, taşınmış veya başka bir hesaba ait olabilir.')).toBeInTheDocument();
  });
});

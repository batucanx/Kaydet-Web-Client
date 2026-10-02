import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { EmailDocument } from './EmailDocument';

describe('Performance — Mail Reader & Long Email Handling', () => {
  it('handles very large/long emails without crashing or layout distortion', () => {
    // Generate 1000-line email
    const lines = Array.from({ length: 1000 }, (_, i) => `<p>Satır ${i + 1}: E-posta gövde metni ve veri içeriği.</p>`).join('\n');
    const largeHtml = `<div class="mail-body">${lines}</div>`;

    render(
      <ThemeProvider>
        <EmailDocument
          html={largeHtml}
          isSanitized={true}
          plainTextFallback={null}
          fontSize={16}
          title="Uzun E-posta"
        />
      </ThemeProvider>,
    );

    const iframe = screen.getByTitle('Uzun E-posta');
    expect(iframe).toBeInTheDocument();
    const srcDoc = iframe.getAttribute('srcdoc') ?? '';
    expect(srcDoc).toContain('Satır 1:');
    expect(srcDoc).toContain('Satır 1000:');
  });

  it('handles table-heavy emails with responsive container rules', () => {
    const tableHtml = `
      <table cellpadding="0" cellspacing="0" width="800">
        <tr>
          <td>Hücre 1</td>
          <td>Hücre 2</td>
        </tr>
      </table>
    `;

    render(
      <ThemeProvider>
        <EmailDocument
          html={tableHtml}
          isSanitized={true}
          plainTextFallback={null}
          fontSize={16}
          title="Tablolu E-posta"
        />
      </ThemeProvider>,
    );

    const iframe = screen.getByTitle('Tablolu E-posta');
    const srcDoc = iframe.getAttribute('srcdoc') ?? '';
    expect(srcDoc).toContain('max-width: 100% !important');
  });

  it('updates font size in document style smoothly', () => {
    const { rerender } = render(
      <ThemeProvider>
        <EmailDocument
          html="<p>Test</p>"
          isSanitized={true}
          plainTextFallback={null}
          fontSize={16}
          title="Font Test"
        />
      </ThemeProvider>,
    );

    let iframe = screen.getByTitle('Font Test');
    expect(iframe.getAttribute('srcdoc')).toContain('font-size: 16px');

    rerender(
      <ThemeProvider>
        <EmailDocument
          html="<p>Test</p>"
          isSanitized={true}
          plainTextFallback={null}
          fontSize={20}
          title="Font Test"
        />
      </ThemeProvider>,
    );

    iframe = screen.getByTitle('Font Test');
    expect(iframe.getAttribute('srcdoc')).toContain('font-size: 20px');
  });
});

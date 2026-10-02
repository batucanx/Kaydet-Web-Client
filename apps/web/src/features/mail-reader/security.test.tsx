import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { EmailDocument } from './EmailDocument';

describe('Security — Email Document & Sandbox Boundaries', () => {
  it('strictly refuses to render iframe when isSanitized is false', () => {
    const maliciousHtml = '<p>Zararlı kod</p><script>alert("hacked")</script>';
    render(
      <ThemeProvider>
        <EmailDocument
          html={maliciousHtml}
          isSanitized={false}
          plainTextFallback="Güvenli düz metin"
        />
      </ThemeProvider>,
    );

    // No iframe should ever be mounted
    expect(screen.queryByTitle('E-posta içeriği')).not.toBeInTheDocument();
    // Fallback text is safely shown as text, not HTML
    expect(screen.getByText('Güvenli düz metin')).toBeInTheDocument();
  });

  it('configures iframe sandbox with strict restrictive permissions', () => {
    render(
      <ThemeProvider>
        <EmailDocument
          html="<p>Güvenli içerik</p>"
          isSanitized={true}
          plainTextFallback={null}
        />
      </ThemeProvider>,
    );

    const iframe = screen.getByTitle('E-posta içeriği');
    const sandbox = iframe.getAttribute('sandbox') ?? '';

    // Permitted: popups to escape sandbox for external links
    expect(sandbox).toContain('allow-popups');
    expect(sandbox).toContain('allow-popups-to-escape-sandbox');

    // FORBIDDEN: scripts, same-origin, top-navigation, forms, pointer-lock
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    expect(sandbox).not.toContain('allow-top-navigation');
    expect(sandbox).not.toContain('allow-forms');
    expect(sandbox).not.toContain('allow-modals');
  });

  it('embeds a restrictive Content-Security-Policy preventing script and form execution', () => {
    render(
      <ThemeProvider>
        <EmailDocument
          html="<p>Test ileti</p>"
          isSanitized={true}
          plainTextFallback={null}
        />
      </ThemeProvider>,
    );

    const iframe = screen.getByTitle('E-posta içeriği');
    const srcDoc = iframe.getAttribute('srcdoc') ?? '';

    expect(srcDoc).toContain('http-equiv="Content-Security-Policy"');
    expect(srcDoc).toContain("default-src 'none'");
    expect(srcDoc).toContain("script-src 'none'");
    expect(srcDoc).toContain("object-src 'none'");
    expect(srcDoc).toContain("form-action 'none'");
    expect(srcDoc).toContain("base-uri 'none'");
  });

  it('strips meta-refresh and meta-viewport tags', () => {
    const raw = '<meta http-equiv="refresh" content="0;url=https://attacker.example"><meta name="viewport" content="width=100"><p>Metin</p>';
    render(
      <ThemeProvider>
        <EmailDocument
          html={raw}
          isSanitized={true}
          plainTextFallback={null}
        />
      </ThemeProvider>,
    );

    const iframe = screen.getByTitle('E-posta içeriği');
    const srcDoc = iframe.getAttribute('srcdoc') ?? '';

    expect(srcDoc).not.toContain('http-equiv="refresh"');
    expect(srcDoc).not.toContain('https://attacker.example');
    expect(srcDoc).toContain('<p>Metin</p>');
  });
});

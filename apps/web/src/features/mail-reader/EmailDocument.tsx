import { useMemo } from 'react';
import {
  resolveColorSchemeQueries,
  stripMetaRefresh,
  stripViewportMeta,
  supportsDarkScheme,
} from '@kaydet/domain';
import { colors } from '@kaydet/tokens';
import { useTheme } from '../../theme/ThemeProvider';
import styles from './EmailDocument.module.css';

export interface EmailDocumentProps {
  html: string | null;
  isSanitized: boolean;
  plainTextFallback: string | null;
  fontSize?: number;
  title?: string;
}

/**
 * Sandboxed, isolated email document renderer.
 *
 * Security architecture:
 * 1. Server sanitizer is authoritative: if `isSanitized !== true`, raw HTML is NEVER rendered.
 * 2. Sandboxed iframe (`sandbox="allow-popups allow-popups-to-escape-sandbox"`):
 *    - NO scripts (`allow-scripts` omitted)
 *    - NO same-origin access (`allow-same-origin` omitted) -> origin is `null`
 *    - NO parent navigation (`allow-top-navigation` omitted)
 *    - NO form submission (`allow-forms` omitted)
 * 3. Restrictive Content Security Policy:
 *    - `default-src 'none'; script-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none';`
 * 4. Smooth native browser scrolling: the iframe document scrolls itself; no parent rerenders on scroll.
 */
export function EmailDocument({
  html,
  isSanitized,
  plainTextFallback,
  fontSize = 16,
  title = 'E-posta içeriği',
}: EmailDocumentProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  const fullDoc = useMemo(() => {
    if (!html || !isSanitized) return null;

    // Preprocess through domain rules
    let cleaned = stripMetaRefresh(html);
    cleaned = stripViewportMeta(cleaned);
    cleaned = resolveColorSchemeQueries(cleaned, { dark: isDark });

    const activeColors = colors[isDark ? 'dark' : 'light'];
    const bodyBg = isDark && !supportsDarkScheme(html) ? activeColors.surfaceElevated : activeColors.bg;
    const bodyColor = activeColors.textPrimary;
    const linkColor = activeColors.accent;
    const borderColor = activeColors.border;
    const quoteTextColor = activeColors.textSecondary;

    return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; object-src 'none'; style-src 'unsafe-inline'; img-src http: https: data: cid:; font-src https: data:; media-src https:; form-action 'none'; base-uri 'none';">
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
    }
    html {
      height: 100%;
      overflow-y: auto;
      overflow-x: auto;
      -webkit-text-size-adjust: 100%;
    }
    body {
      margin: 0;
      padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: ${fontSize}px;
      line-height: 1.6;
      word-break: break-word;
      overflow-wrap: break-word;
      color: ${bodyColor};
      background-color: ${bodyBg};
    }
    img {
      max-width: 100% !important;
      height: auto !important;
      vertical-align: middle;
    }
    table {
      max-width: 100% !important;
    }
    a {
      color: ${linkColor};
      text-decoration: underline;
    }
    pre, code {
      white-space: pre-wrap;
      word-break: break-all;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    blockquote {
      margin: 12px 0;
      padding-left: 12px;
      border-left: 3px solid ${borderColor};
      color: ${quoteTextColor};
    }
  </style>
</head>
<body>${cleaned}</body>
</html>`;
  }, [html, isSanitized, isDark, fontSize]);

  // If sanitized HTML is available and validated, render inside sandboxed iframe
  if (html && isSanitized && fullDoc !== null) {
    return (
      <div className={styles.documentContainer}>
        <iframe
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={fullDoc}
          title={title}
          className={styles.iframe}
        />
      </div>
    );
  }

  // Fallback: Safe Plain Text Rendering
  if (plainTextFallback && plainTextFallback.trim() !== '') {
    return (
      <div className={styles.plainTextContainer}>
        <pre className={styles.plainText}>{plainTextFallback}</pre>
      </div>
    );
  }

  // Empty Body Fallback
  return (
    <div className={styles.documentContainer}>
      <div className={styles.emptyBodyNotice} role="note">
        Bu iletinin gövdesi boş.
      </div>
    </div>
  );
}

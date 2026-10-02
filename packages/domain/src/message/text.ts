/**
 * HTML → plain text, preview generation and e-mail-HTML preprocessing helpers.
 *
 * SOURCE: mobile `lib/domain/use_cases/text_extraction.dart` (`TextExtraction`; tests:
 *         `test/text_and_models_test.dart`, `test/text_hardening_test.dart`).
 * PURPOSE: Most real mail is HTML. The list preview cannot afford a real HTML parser, so a light,
 *          dependency-free cleaner is used. Every scanner here is LINEAR-time on purpose: the naive regexes
 *          (`<[^>]+>`, `<!--.*?-->`, unclosed `<style>`) rescan to the end of the document for every opener and
 *          were quadratic on hostile mail with many unclosed openers.
 *          `htmlToPlain` is NOT a sanitizer and its output must never be used as HTML; sanitising HTML for
 *          display is a separate, security-critical step (server + sandboxed iframe), see the API contract.
 * WEB USAGE: server preview generation (`buildPreview` → `MessageSummaryDTO.preview`), plain-text
 *            alternative of an HTML-only mail, reply/forward quoting (`quoteText`), and preprocessing of mail
 *            HTML before it is handed to the (separately built) sanitiser/renderer.
 */

const BLOCK_OPEN = /<(script|style|head|title)\b/gi;
type BlockName = 'script' | 'style' | 'head' | 'title';
const BLOCK_CLOSE: Readonly<Record<BlockName, RegExp>> = {
  script: /<\/script\s*>/gi,
  style: /<\/style\s*>/gi,
  head: /<\/head\s*>/gi,
  title: /<\/title\s*>/gi,
};
const QUOTE_HEADER = /(yazdı|wrote|schrieb)\s*:$/i;
const FORWARD_HEADER = /^-{3,}\s*(Orijinal|Original|İletilen|Forwarded)/i;
const WHITESPACE_RUN = /\s+/g;
const ENTITY_PATTERN = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;
const BLOCK_END = /<\/\s*(p|div|tr|li|h[1-6]|blockquote|table|section|article)\s*>/gi;
const LINE_BREAK = /<\s*(br|hr)\s*\/?\s*>/gi;
const MANY_SPACES = /[ \t\u00a0]+/g;
const MANY_NEWLINES = /\n{3,}/g;

const ENTITIES: Readonly<Record<string, string>> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&hellip;': '…',
  '&mdash;': '—',
  '&ndash;': '–',
  '&laquo;': '«',
  '&raquo;': '»',
  '&uuml;': 'ü',
  '&Uuml;': 'Ü',
  '&ouml;': 'ö',
  '&Ouml;': 'Ö',
  '&ccedil;': 'ç',
  '&Ccedil;': 'Ç',
  '&shy;': '',
  '&zwnj;': '',
};

/** Replaces remaining `<…>` tags with a space, in linear time. `<>` is not a tag; a trailing `<` without `>` stays. */
function stripTags(text: string): string {
  let open = text.indexOf('<');
  if (open === -1) return text;
  let out = '';
  let position = 0;
  while (open !== -1) {
    const close = text.indexOf('>', open + 1);
    if (close === -1) break;
    if (close === open + 1) {
      open = text.indexOf('<', close);
      continue;
    }
    out += `${text.slice(position, open)} `;
    position = close + 1;
    open = text.indexOf('<', position);
  }
  return out + text.slice(position);
}

/** Drops `<!-- … -->` comments (replaced by a space). An unclosed `<!--` stays as it is. */
function stripComments(html: string): string {
  if (!html.includes('<!--')) return html;
  let out = '';
  let position = 0;
  for (;;) {
    const start = html.indexOf('<!--', position);
    if (start === -1) break;
    const end = html.indexOf('-->', start + 4);
    if (end === -1) break;
    out += `${html.slice(position, start)} `;
    position = end + 3;
  }
  return out + html.slice(position);
}

/**
 * Drops `<script|style|head|title>` blocks with their content (each becomes a space). An unclosed block
 * stays. If a closer was not found once for a tag name it does not exist for later openers either, which
 * keeps this linear.
 */
function stripBlocks(html: string): string {
  let out = '';
  const unclosed = new Set<string>();
  let position = 0;
  BLOCK_OPEN.lastIndex = 0;
  for (const open of html.matchAll(BLOCK_OPEN)) {
    const openStart = open.index;
    // An opener nested inside a block that was just dropped.
    if (openStart < position) continue;
    const name = (open[1] as string).toLowerCase() as BlockName;
    if (unclosed.has(name)) continue;
    const tagEnd = html.indexOf('>', openStart + open[0].length);
    // With no `>` left, no opening tag can be completed any more.
    if (tagEnd === -1) break;
    const closeRe = BLOCK_CLOSE[name];
    closeRe.lastIndex = tagEnd + 1;
    const close = closeRe.exec(html);
    if (close === null) {
      unclosed.add(name);
      continue;
    }
    out += `${html.slice(position, openStart)} `;
    position = close.index + close[0].length;
  }
  return out + html.slice(position);
}

/**
 * Decodes HTML entities (named + numeric) in a SINGLE pass: with a separate, earlier `&amp;` step `&amp;lt;`
 * would become `&lt;` and then `<` (decoded twice). Unknown entities and invalid code points stay as written.
 */
export function decodeEntities(input: string): string {
  return input.replace(ENTITY_PATTERN, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body.length > 1 && (body[1] === 'x' || body[1] === 'X');
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // NUL and lone surrogates are not valid text.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    return ENTITIES[`&${body};`] ?? whole;
  });
}

/** HTML → readable plain text (structure of lines kept). Output is text, never HTML. */
export function htmlToPlain(html: string): string {
  let text = html;
  text = stripComments(text);
  text = stripBlocks(text);
  text = text.replace(LINE_BREAK, '\n');
  text = text.replace(BLOCK_END, '\n');
  text = stripTags(text);
  text = decodeEntities(text);
  text = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  text = text
    .split('\n')
    .map((line) => line.replace(MANY_SPACES, ' ').trim())
    .join('\n');
  text = text.replace(MANY_NEWLINES, '\n\n');
  return text.trim();
}

/**
 * List-row preview. Skips quoted reply blocks and signatures: the information for the user is at the top.
 * Stops at a `--` signature delimiter, at "… yazdı:" / "wrote:" quote headers and at forward headers.
 * If nothing survives (e.g. a mail that only quotes), falls back to the whole text so a preview still shows.
 */
export function buildPreview(plainText: string | null | undefined, maxLength = 140): string {
  if (plainText == null || plainText.trim() === '') return '';
  const kept: string[] = [];
  let keptLength = 0;

  for (const rawLine of plainText.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith('>')) continue; // quoted line
    if (line === '--' || line === '-- ') break; // signature delimiter: everything after is signature
    if (QUOTE_HEADER.test(line)) break;
    if (FORWARD_HEADER.test(line)) break;
    kept.push(line);
    keptLength += line.length + (kept.length > 1 ? 1 : 0);
    if (keptLength >= maxLength) break;
  }

  let preview = kept.join(' ').replace(WHITESPACE_RUN, ' ').trim();
  if (preview === '') preview = plainText.replace(WHITESPACE_RUN, ' ').trim();
  if (preview.length <= maxLength) return preview;
  return `${preview.slice(0, maxLength).trimEnd()}…`;
}

/** Quote block for a reply body: every line prefixed with `> ` (empty lines with `>`). */
export function quoteText(plainText: string): string {
  return plainText
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

const PREFERS_DARK = /prefers-color-scheme\s*:\s*dark/i;
const COLOR_SCHEME_QUERY = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi;

/**
 * Does the mail bring its own dark theme? Mail with `@media (prefers-color-scheme: dark)` (modern templates,
 * system notifications) carries a dark design of its own; recolouring it on top would break the palette.
 */
export function supportsDarkScheme(html: string): boolean {
  return PREFERS_DARK.test(html);
}

/**
 * Pins `prefers-color-scheme` media queries to the APP's theme. A renderer evaluates them against the system
 * theme, but Kaydet has its own theme preference. A matching query becomes always-true (`min-width: 0px`), a
 * non-matching one always-false (`max-width: 0px`); the rest of the query (`and`, `not`, lists) is kept.
 */
export function resolveColorSchemeQueries(html: string, options: { dark: boolean }): string {
  return html.replace(COLOR_SCHEME_QUERY, (_m, scheme: string) =>
    (scheme.toLowerCase() === 'dark') === options.dark ? '(min-width: 0px)' : '(max-width: 0px)',
  );
}

const META_REFRESH = /<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']?\s*refresh\b)[^>]*>/gi;
const META_VIEWPORT = /<meta\b(?=[^>]*\bname\s*=\s*["']viewport["'])[^>]*>/gi;

/**
 * Removes `<meta http-equiv="refresh">`. It redirects the moment the mail is opened, with no interaction
 * (phishing/tracking).
 */
export function stripMetaRefresh(html: string): string {
  return html.replace(META_REFRESH, '');
}

/**
 * Removes the source mail's own `<meta name="viewport">`. Newsletters are full HTML documents with their own
 * viewport meta; when embedded in the host document the browser moves stray `<meta>` into the real `<head>`
 * AFTER ours and, with several viewport tags, honours the LAST one — silently overriding ours. Stripping theirs
 * before wrapping guarantees ours is the only one.
 */
export function stripViewportMeta(html: string): string {
  return html.replace(META_VIEWPORT, '');
}

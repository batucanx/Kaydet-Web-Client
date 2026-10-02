/**
 * Turkish text handling.
 *
 * SOURCE: mobile `lib/core/turkish.dart` (`trLower`, `trUpper`, `foldForSearch`, `normalizeSubject`,
 *         `displayNameFromEmail`, `avatarInitial`).
 * PURPOSE: Locale-insensitive casing is wrong for Turkish ('I'.toLowerCase() → 'i', 'İ' loses its dot),
 *          so every Turkish string goes through these helpers. `foldForSearch` is the single normal form
 *          for both the search index and the search query: both sides MUST use it.
 * WEB USAGE: sorting/filtering (web + server), search (server index + query), reply-prefix handling in
 *            threading and compose, avatar initials/tones, display-name fallback from an address.
 *
 * These deliberately do NOT use `toLocaleLowerCase('tr')`: the mobile semantics are per-code-point with
 * exactly the I/İ/i/ı exceptions below, independent of the ICU data of the runtime.
 */

/** Turkish lower-casing (I→ı, İ→i). Every other code point uses the default mapping. */
export function trLower(input: string): string {
  let out = '';
  for (const ch of input) {
    if (ch === 'I') out += 'ı';
    else if (ch === 'İ') out += 'i'; // İ
    else out += ch.toLowerCase();
  }
  return out;
}

/** Turkish upper-casing (i→İ, ı→I). Every other code point uses the default mapping. */
export function trUpper(input: string): string {
  let out = '';
  for (const ch of input) {
    if (ch === 'i') out += 'İ'; // İ
    else if (ch === 'ı') out += 'I';
    else out += ch.toUpperCase();
  }
  return out;
}

const FOLD_MAP: Readonly<Record<string, string>> = {
  ç: 'c', Ç: 'c',
  ğ: 'g', Ğ: 'g',
  ı: 'i', İ: 'i',
  ö: 'o', Ö: 'o',
  ş: 's', Ş: 's',
  ü: 'u', Ü: 'u',
  â: 'a', Â: 'a',
  î: 'i', Î: 'i',
  û: 'u', Û: 'u',
};

/**
 * Search normal form: Turkish lower-case + accent folding, so "sahan" finds "Şahan" and "gorusme" finds
 * "Görüşme". Output is what the index stores and what a query is compared against.
 */
export function foldForSearch(input: string): string {
  let out = '';
  for (const ch of trLower(input)) out += FOLD_MAP[ch] ?? ch;
  return out;
}

/** Reply/forward prefixes in folded form (mobile `_replyPrefixes`). */
const REPLY_PREFIXES: ReadonlySet<string> = new Set([
  're', 'fw', 'fwd', 'yan', 'ynt', 'ilt', 'yanit', 'iletilen', 'yonlendirilen',
]);

const SUBJECT_PREFIX = /^(\p{L}{2,12})\s*(\[\d+\])?\s*:\s*/u;

/**
 * Strips reply/forward prefixes (English `Re:`/`Fwd:`, Turkish `Yan:`/`Ynt:`/`İlt:`/`Yanıt:`, counters like
 * `Re[2]:`, repeated prefixes). Comparison goes through {@link foldForSearch}: a case-insensitive regex
 * would not match `İlt:` (U+0130) against `ilt`.
 */
export function normalizeSubject(subject: string | null | undefined): string {
  if (subject == null) return '';
  // Folded headers can contain line breaks; collapse to a single line.
  let text = subject.replace(/\s+/g, ' ').trim();
  for (;;) {
    const match = SUBJECT_PREFIX.exec(text);
    if (!match) break;
    if (!REPLY_PREFIXES.has(foldForSearch(match[1] as string))) break;
    text = text.slice(match[0].length).trim();
  }
  return text;
}

/**
 * Display name derived from an address: `ahmet.yilmaz@firma.com` → `Ahmet Yilmaz`.
 * Capitalisation uses the Turkish rules on purpose (`ismail` → `İsmail`, therefore `info` → `İnfo`):
 * the audience writes Turkish, and mobile made the same trade-off.
 */
export function displayNameFromEmail(email: string): string {
  const at = email.indexOf('@');
  const local = at > 0 ? email.slice(0, at) : email;
  const parts = local.split(/[._\-+]/).filter((p) => p.length > 0);
  if (parts.length === 0) return email;
  return parts
    .map((p) => (p.length === 1 ? trUpper(p) : `${trUpper(p[0] as string)}${trLower(p.slice(1))}`))
    .join(' ');
}

/** Avatar letter: the first letter/digit of the name, else of the address; `?` when none. */
export function avatarInitial(name: string | null | undefined, email: string | null | undefined): string {
  const trimmedName = name?.trim();
  const source = trimmedName ? trimmedName : (email ?? '').trim();
  for (const ch of source) {
    if (/[\p{L}\p{N}]/u.test(ch)) return trUpper(ch);
  }
  return '?';
}

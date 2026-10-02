/**
 * Stable per-sender avatar tone and brand-logo eligibility.
 *
 * SOURCE: mobile `lib/core/avatar.dart` (`AvatarHash`, `PersonalEmailDomains`).
 * PURPOSE: The same person always gets the same colour (FNV-1a over the whole address; the earlier
 *          `charCodeAt(0) % 15` gave every "A…" the same colour). Free-mail domains never get a brand
 *          logo because everyone on gmail.com would share Gmail's "G".
 * WEB USAGE: `Avatar` component (tone), brand-logo lookup decision.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a over UTF-16 code units (identical to Dart `String.codeUnits`). */
export function fnv1a32(input: string): number {
  let value = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    value = (value ^ input.charCodeAt(i)) >>> 0;
    value = Math.imul(value, FNV_PRIME) >>> 0;
  }
  return value;
}

/** Tone index for a sender: keyed by the address (stable, unique), falling back to the display name. */
export function avatarToneIndex(
  email: string | null | undefined,
  name: string | null | undefined,
  toneCount: number,
): number {
  if (toneCount <= 0) return 0;
  const key = email?.trim() ? email.trim().toLowerCase() : (name ?? '').trim().toLowerCase();
  if (!key) return 0;
  return fnv1a32(key) % toneCount;
}

const PERSONAL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.com.tr', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.com.tr', 'icloud.com', 'me.com', 'mac.com', 'yandex.com', 'yandex.com.tr',
  'protonmail.com', 'proton.me', 'mail.ru', 'gmx.com', 'gmx.net', 'aol.com',
]);

/** Personal/free mail providers: no brand logo is looked up for these domains. */
export function isPersonalEmailDomain(domain: string): boolean {
  return PERSONAL_DOMAINS.has(domain);
}

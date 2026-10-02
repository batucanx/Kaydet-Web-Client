/**
 * E-mail address value rules.
 *
 * SOURCE: mobile `lib/domain/models/mail_models.dart` → `EmailAddress` (`display`, `formatted`,
 *         `parseInput`, `isValid`/`isValidEmail`, case-insensitive equality) and
 *         `lib/core/avatar.dart` (`domainOf`).
 * PURPOSE: One parser/formatter for the To/Cc/Bcc inputs and reply prefill, so that
 *          `formatAddress` → `parseAddressList` never confuses a display name with an address.
 * WEB USAGE: compose recipient inputs, reply/forward prefill, list sender display, server-side
 *            validation of outgoing recipients.
 *
 * Not ported: `toMap/fromMap/encodeList/decodeList` (mobile's SQLite JSON column format, storage detail).
 */
import { displayNameFromEmail } from '../turkish/index.ts';

/** Structural address type: satisfied by the API `EmailAddress` DTO and by any parsed input. */
export interface AddressLike {
  readonly email: string;
  readonly name?: string | null | undefined;
}

/** Name shown for an address: the display name, else one derived from the address. */
export function addressDisplay(address: AddressLike): string {
  const name = address.name?.trim();
  return name ? name : displayNameFromEmail(address.email);
}

const NAME_NEEDS_QUOTES = /[,;"<>]/;

/**
 * RFC 5322 form `Ad Soyad <adres@alan.com>`. Names containing `, ; " < >` are quoted: the parser keeps a
 * comma only inside quotes, so an unquoted `Yılmaz, Ahmet <a@x.com>` would split into two recipients.
 * A quote character inside the name cannot be preserved and is dropped.
 */
export function formatAddress(address: AddressLike): string {
  const name = address.name?.trim();
  if (!name) return address.email;
  if (NAME_NEEDS_QUOTES.test(name)) return `"${name.replaceAll('"', '')}" <${address.email}>`;
  return `${name} <${address.email}>`;
}

/** Parses `"Ad Soyad" <a@b.com>, c@d.com` (comma or semicolon separated). Empty name ⇒ `''`. */
export function parseAddressList(raw: string): Array<{ email: string; name: string }> {
  if (raw.trim() === '') return [];

  // A small state machine keeps separators that appear inside quotes.
  const chunks: string[] = [];
  let buffer = '';
  let inQuotes = false;
  for (const ch of raw) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      buffer += ch;
    } else if ((ch === ',' || ch === ';') && !inQuotes) {
      chunks.push(buffer);
      buffer = '';
    } else {
      buffer += ch;
    }
  }
  chunks.push(buffer);

  const result: Array<{ email: string; name: string }> = [];
  for (const chunk of chunks) {
    const text = chunk.trim();
    if (text === '') continue;
    const match = /^(.*?)<([^>]+)>$/.exec(text);
    if (match) {
      let name = (match[1] as string).trim();
      if (name.length > 1 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
      result.push({ email: (match[2] as string).trim(), name });
    } else {
      result.push({ email: text, name: '' });
    }
  }
  return result;
}

const EMAIL_PATTERN =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/** Syntactic e-mail check (mobile `isValidEmail`); a domain needs at least one dot. */
export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

/** Address equality is case-insensitive on the mailbox (mobile `EmailAddress.==`). */
export function sameAddress(a: AddressLike, b: AddressLike): boolean {
  return a.email.toLowerCase() === b.email.toLowerCase();
}

/** `ali@sirket.com` → `sirket.com`; `null` when there is no usable domain. */
export function domainOf(email: string | null | undefined): string | null {
  if (email == null) return null;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  if (at < 0 || at === trimmed.length - 1) return null;
  const domain = trimmed.slice(at + 1);
  return domain === '' ? null : domain;
}

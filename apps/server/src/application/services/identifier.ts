/**
 * Login identifiers. The Phase 2 contract only says "the user's Kaydet login name; format owned by the auth
 * phase". Decision: an identifier is a printable string without whitespace or control characters (typically an
 * e-mail address), compared case-insensitively after Unicode NFKC normalisation. No other identifier types.
 *
 * Normalisation is applied at user creation AND at login, so "Ali@Example.com" and "ali@example.com" are one user.
 */
const MAX_IDENTIFIER_LENGTH = 320;

/** The canonical form, or `null` when the input cannot be an identifier. */
export function normaliseIdentifier(raw: string): string | null {
  const normalised = raw.normalize('NFKC').trim().toLowerCase();
  if (normalised === '' || normalised.length > MAX_IDENTIFIER_LENGTH) return null;
  // Whitespace inside, control/format characters (incl. bidi overrides): not an identifier.
  if (/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalised)) return null;
  return normalised;
}

/**
 * The Kaydet user key of a mailbox sign-in: address AND mail server. The server is part of the key on purpose: the
 * proof of ownership is "this server accepted this password", so two different servers claiming the same address must
 * be two different users — otherwise anyone could point the sign-in at a server of their own that accepts any password
 * and walk into somebody else's Kaydet user.
 */
export function mailboxIdentifier(email: string, imapHost: string): string | null {
  return normaliseIdentifier(`${email.trim()}#${imapHost.trim()}`);
}

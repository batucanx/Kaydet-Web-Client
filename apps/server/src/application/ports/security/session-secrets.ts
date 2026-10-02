/**
 * Cryptographic primitives for sessions, behind a port so the application layer imports no crypto library.
 *
 *   secret        256 random bits → the ONLY thing the browser holds (HttpOnly cookie)
 *   fingerprint   one-way hash of the secret → what the server stores and looks sessions up by
 *   csrfToken     keyed derivation from the secret → the CSRF token (a value of its own: it cannot be turned back
 *                 into the secret, and holding it does not authenticate anything)
 */
export interface SessionSecrets {
  generate(): string;
  fingerprint(secret: string): string;
  csrfToken(secret: string): string;
  /** Constant-time comparison of two strings (any length). */
  equals(a: string, b: string): boolean;
}

/**
 * Brute-force protection for sign-in.
 *
 * Two independent keys are throttled: the normalised IDENTIFIER (protects one account from being guessed, even
 * from many addresses) and the client ADDRESS (protects against one source trying many identifiers = credential
 * stuffing). Both use temporary, exponentially growing back-off — never a permanent lockout, so an attacker cannot
 * lock a victim out for good. The answer must not depend on whether the identifier exists.
 *
 * The Phase-4 adapter is in-memory (single process, development/single-instance protection). A distributed
 * adapter (shared store) can implement the same port.
 */
export interface LoginAttempt {
  /** Already normalised (see `normaliseIdentifier`). */
  readonly identifier: string;
  readonly address: string;
}

export type ThrottleDecision = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface LoginRateLimiter {
  /** Called BEFORE verifying a password. A blocked attempt is neither verified nor counted. */
  check(attempt: LoginAttempt): Promise<ThrottleDecision>;
  recordFailure(attempt: LoginAttempt): Promise<void>;
  /** Clears the identifier's counter only; the address counter is NOT reset (a valid account of the attacker's own must not wash it). */
  recordSuccess(attempt: LoginAttempt): Promise<void>;
}

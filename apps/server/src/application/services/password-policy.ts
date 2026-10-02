/**
 * Password policy — what a NEW password must satisfy (user creation now, password change later).
 *
 *  - at least `minLength` characters (default 10): length is what buys resistance to guessing;
 *  - at most `maxLength` characters (default 256): bounds the work an attacker can force on the hasher;
 *  - not blank (whitespace only);
 *  - no composition rules (mandatory symbols/cases add friction, not security — NIST SP 800-63B).
 *
 * At LOGIN only the upper bound matters (see `AuthService`): an existing password is never rejected for being
 * "too weak", it simply does not match. Reasons are stable codes; the password itself is never echoed.
 */
export type PasswordPolicyViolation = 'too_short' | 'too_long' | 'blank';

export interface PasswordLimits {
  readonly minLength: number;
  readonly maxLength: number;
}

export function checkPasswordPolicy(password: string, limits: PasswordLimits): PasswordPolicyViolation | null {
  const length = [...password].length; // code points, not UTF-16 units
  if (password.trim() === '') return 'blank';
  if (length < limits.minLength) return 'too_short';
  if (length > limits.maxLength) return 'too_long';
  return null;
}

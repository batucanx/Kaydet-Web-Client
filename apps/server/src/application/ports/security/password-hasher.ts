/**
 * Password hashing. Application code depends on this abstraction only; the production implementation (Argon2id,
 * parameters centralised in ONE place) lives in infrastructure. Passwords are hashed, never encrypted: there is no
 * operation that recovers one.
 */
export interface PasswordHasher {
  /** Self-describing, salted hash string (algorithm and parameters included, so parameters can change later). */
  hash(password: string): Promise<string>;
  /**
   * `true` only for a match. A malformed or unsupported hash is `false`, never an exception: callers treat it as
   * a failed login, and a corrupt record must not become an oracle.
   */
  verify(password: string, passwordHash: string): Promise<boolean>;
}

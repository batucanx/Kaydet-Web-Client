/**
 * A server-side session. The browser's secret is NOT stored — only its fingerprint (`secretFingerprint`), so a leaked
 * store cannot be replayed as cookies.
 */
export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly secretFingerprint: string;
  readonly createdAt: Date;
  /** Absolute end of life. */
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
  readonly revokedAt: Date | null;
}

export interface SessionRepository {
  create(session: SessionRecord): Promise<void>;
  findByFingerprint(secretFingerprint: string): Promise<SessionRecord | null>;
  touch(sessionId: string, seenAt: Date): Promise<void>;
  /** Idempotent: revoking a revoked/unknown session is a no-op. */
  revoke(sessionId: string, at: Date): Promise<void>;
  /** Revokes every live session of the user (except `exceptSessionId`); returns how many were revoked. */
  revokeAllForUser(userId: string, at: Date, exceptSessionId?: string): Promise<number>;
}

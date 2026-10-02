import type {
  CredentialRepository,
  EncryptedCredentialRecord,
  SessionRecord,
  SessionRepository,
  UserRecord,
  UserRepository,
} from '../../application/index.ts';

/** Non-durable users. Uniqueness of the identifier is enforced here, in one step (a database uses a unique index). */
export class MemoryUserRepository implements UserRepository {
  private readonly users = new Map<string, UserRecord>();

  findByIdentifier(identifier: string): Promise<UserRecord | null> {
    for (const user of this.users.values()) if (user.identifier === identifier) return Promise.resolve(user);
    return Promise.resolve(null);
  }

  findById(userId: string): Promise<UserRecord | null> {
    return Promise.resolve(this.users.get(userId) ?? null);
  }

  create(user: UserRecord): Promise<boolean> {
    for (const existing of this.users.values()) if (existing.identifier === user.identifier) return Promise.resolve(false);
    this.users.set(user.id, user);
    return Promise.resolve(true);
  }

  updatePasswordHash(userId: string, passwordHash: string, at: Date): Promise<void> {
    const user = this.users.get(userId);
    if (user !== undefined) this.users.set(userId, { ...user, passwordHash, updatedAt: at });
    return Promise.resolve();
  }
}

/** Non-durable sessions, indexed by the secret's fingerprint (the secret itself is never stored). */
export class MemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, SessionRecord>();

  create(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, session);
    return Promise.resolve();
  }

  findByFingerprint(secretFingerprint: string): Promise<SessionRecord | null> {
    for (const session of this.sessions.values()) if (session.secretFingerprint === secretFingerprint) return Promise.resolve(session);
    return Promise.resolve(null);
  }

  touch(sessionId: string, seenAt: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) this.sessions.set(sessionId, { ...session, lastSeenAt: seenAt });
    return Promise.resolve();
  }

  revoke(sessionId: string, at: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session !== undefined && session.revokedAt === null) this.sessions.set(sessionId, { ...session, revokedAt: at });
    return Promise.resolve();
  }

  revokeAllForUser(userId: string, at: Date, exceptSessionId?: string): Promise<number> {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.revokedAt === null && session.id !== exceptSessionId) {
        this.sessions.set(session.id, { ...session, revokedAt: at });
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  /** Test inspection: every stored record (fingerprints only — no secret exists to leak). */
  snapshot(): SessionRecord[] {
    return [...this.sessions.values()];
  }
}

/** Non-durable encrypted credential records; `replace` is a single map write (atomic). */
export class MemoryCredentialRepository implements CredentialRepository {
  private readonly records = new Map<string, EncryptedCredentialRecord>();

  find(accountId: string): Promise<EncryptedCredentialRecord | null> {
    return Promise.resolve(this.records.get(accountId) ?? null);
  }

  replace(accountId: string, record: EncryptedCredentialRecord): Promise<void> {
    this.records.set(accountId, record);
    return Promise.resolve();
  }

  remove(accountId: string): Promise<void> {
    this.records.delete(accountId);
    return Promise.resolve();
  }

  /** Test inspection: the stored envelopes. */
  snapshot(): Map<string, EncryptedCredentialRecord> {
    return new Map(this.records);
  }
}

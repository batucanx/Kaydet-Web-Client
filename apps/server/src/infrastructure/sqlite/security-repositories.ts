import type { EncryptedCredentialRecord, CredentialRepository, SessionRecord, SessionRepository, UserRecord, UserRepository } from '../../application/index.ts';
import { fromIso, fromIsoOrNull, text, textOrNull, toIso } from './common.ts';
import { isUniqueViolation } from './database.ts';
import type { SqliteDatabase } from './database.ts';

type UserRow = { id: unknown; identifier: unknown; password_hash: unknown; created_at: unknown; updated_at: unknown };
const toUser = (row: UserRow): UserRecord => ({
  id: text(row.id),
  identifier: text(row.identifier),
  passwordHash: text(row.password_hash),
  createdAt: fromIso(text(row.created_at)),
  updatedAt: fromIso(text(row.updated_at)),
});
const USER_COLUMNS = 'id, identifier, password_hash, created_at, updated_at';

export class SqliteUserRepository implements UserRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async findByIdentifier(identifier: string): Promise<UserRecord | null> {
    const row = await this.db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE identifier = ?`, [identifier]);
    return row === undefined ? null : toUser(row);
  }

  async findById(userId: string): Promise<UserRecord | null> {
    const row = await this.db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [userId]);
    return row === undefined ? null : toUser(row);
  }

  async create(user: UserRecord): Promise<boolean> {
    try {
      await this.db.run(`INSERT INTO users (${USER_COLUMNS}) VALUES (?, ?, ?, ?, ?)`, [
        user.id,
        user.identifier,
        user.passwordHash,
        toIso(user.createdAt),
        toIso(user.updatedAt),
      ]);
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false; // the unique index on the normalised identifier is the guarantee
      throw error;
    }
  }

  async updatePasswordHash(userId: string, passwordHash: string, at: Date): Promise<void> {
    await this.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [passwordHash, toIso(at), userId]);
  }
}

type SessionRow = { id: unknown; user_id: unknown; secret_fingerprint: unknown; created_at: unknown; expires_at: unknown; last_seen_at: unknown; revoked_at: unknown };
const SESSION_COLUMNS = 'id, user_id, secret_fingerprint, created_at, expires_at, last_seen_at, revoked_at';
const toSession = (row: SessionRow): SessionRecord => ({
  id: text(row.id),
  userId: text(row.user_id),
  secretFingerprint: text(row.secret_fingerprint),
  createdAt: fromIso(text(row.created_at)),
  expiresAt: fromIso(text(row.expires_at)),
  lastSeenAt: fromIso(text(row.last_seen_at)),
  revokedAt: fromIsoOrNull(row.revoked_at),
});

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async create(session: SessionRecord): Promise<void> {
    await this.db.run(`INSERT INTO sessions (${SESSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
      session.id,
      session.userId,
      session.secretFingerprint,
      toIso(session.createdAt),
      toIso(session.expiresAt),
      toIso(session.lastSeenAt),
      session.revokedAt === null ? null : toIso(session.revokedAt),
    ]);
  }

  async findByFingerprint(secretFingerprint: string): Promise<SessionRecord | null> {
    const row = await this.db.get<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE secret_fingerprint = ?`, [secretFingerprint]);
    return row === undefined ? null : toSession(row);
  }

  async touch(sessionId: string, seenAt: Date): Promise<void> {
    await this.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [toIso(seenAt), sessionId]);
  }

  async revoke(sessionId: string, at: Date): Promise<void> {
    await this.db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [toIso(at), sessionId]);
  }

  async revokeAllForUser(userId: string, at: Date, exceptSessionId?: string): Promise<number> {
    const { changes } =
      exceptSessionId === undefined
        ? await this.db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [toIso(at), userId])
        : await this.db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?', [toIso(at), userId, exceptSessionId]);
    return changes;
  }

  /** Test inspection: every stored record (fingerprints only). */
  async snapshot(): Promise<SessionRecord[]> {
    return (await this.db.all<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY created_at, rowid`)).map(toSession);
  }
}

/**
 * Encrypted credential envelopes. THIS CLASS NEVER DECRYPTS: it stores and returns an opaque string. Only the credential
 * vault (with the `CryptoPort`) can turn it back into a credential.
 */
export class SqliteCredentialRepository implements CredentialRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async find(accountId: string): Promise<EncryptedCredentialRecord | null> {
    const row = await this.db.get('SELECT encrypted_value, key_id, updated_at FROM mail_account_credentials WHERE account_id = ?', [accountId]);
    return row === undefined ? null : { ciphertext: text(row['encrypted_value']), keyId: textOrNull(row['key_id']), updatedAt: fromIso(text(row['updated_at'])) };
  }

  /** One statement: the envelope is replaced in a single step, `created_at` survives. */
  async replace(accountId: string, record: EncryptedCredentialRecord): Promise<void> {
    const at = toIso(record.updatedAt);
    await this.db.run(
      `INSERT INTO mail_account_credentials (account_id, encrypted_value, key_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET encrypted_value = excluded.encrypted_value, key_id = excluded.key_id, updated_at = excluded.updated_at`,
      [accountId, record.ciphertext, record.keyId, at, at],
    );
  }

  async remove(accountId: string): Promise<void> {
    await this.db.run('DELETE FROM mail_account_credentials WHERE account_id = ?', [accountId]);
  }
}

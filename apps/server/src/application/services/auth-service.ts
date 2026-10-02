/**
 * Kaydet user authentication and sessions — the application's ONLY authority on who is signed in.
 *
 *   login:   identifier + password ─▶ throttle ─▶ user lookup ─▶ verify (dummy hash if unknown) ─▶ NEW session
 *   resolve: cookie secret ─▶ fingerprint ─▶ session ─▶ (revoked? absolute expiry? idle expiry?) ─▶ user ─▶ active
 *   logout:  revoke the session server-side (deleting the cookie alone would leave it usable)
 *
 * Kaydet credentials and mail-provider credentials are unrelated: the Kaydet password is only ever compared with the
 * Kaydet user's hash and is never used with, or stored next to, a mail credential.
 */
import { AppError } from '../errors.ts';
import type { SecurityPolicy } from '../../config/config.types.ts';
import type { Clock } from '../ports/clock/clock.ts';
import type { IdGenerator } from '../ports/ids/id-generator.ts';
import type { SessionRepository } from '../ports/repositories/session-repository.ts';
import type { UserRepository } from '../ports/repositories/user-repository.ts';
import type { LoginRateLimiter } from '../ports/security/login-rate-limiter.ts';
import type { PasswordHasher } from '../ports/security/password-hasher.ts';
import type { SessionSecrets } from '../ports/security/session-secrets.ts';
import type { UnitOfWork } from '../ports/transaction/unit-of-work.ts';
import { normaliseIdentifier } from './identifier.ts';

/** What a presented session credential resolves to. `expired` covers expired, idle, revoked and unknown alike. */
export type ResolvedSession =
  | { readonly status: 'none' }
  | { readonly status: 'expired' }
  | { readonly status: 'active'; readonly sessionId: string; readonly userId: string; readonly expiresAt: Date; readonly csrfToken: string };

export interface IssuedSession {
  /** The session SECRET for the cookie. Exists only here and in the cookie; never logged, never in a DTO. */
  readonly token: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly csrfToken: string;
}

export interface LoginInput {
  readonly identifier: string;
  readonly password: string;
  readonly clientAddress: string;
  /** Id of the session the browser presented (if any). It is revoked: a session is never carried across a login. */
  readonly replacingSessionId: string | null;
}

export interface MailboxLoginInput {
  /** User key derived from the mailbox (see `mailboxIdentifier`); normalised here. */
  readonly identifier: string;
  readonly clientAddress: string;
  readonly replacingSessionId: string | null;
  /** Proves the mailbox credentials with the mail provider. No database access, no open transaction. Throws an AppError on failure. */
  readonly verify: () => Promise<void>;
  /** Runs inside the sign-in transaction, after the user exists: attaches/refreshes the mail account. */
  readonly attach: (user: { readonly userId: string; readonly isNew: boolean }) => Promise<void>;
}

export interface AuthService {
  /**
   * Sign-in by mailbox: the mail provider is the authority. Throttled like a password login; a failed provider check
   * counts as a failed attempt. The Kaydet user is found or created and has NO usable Kaydet password (its hash is of a
   * random secret nobody sees), so the only way in is a mailbox the provider accepts.
   */
  loginWithMailbox(input: MailboxLoginInput): Promise<IssuedSession>;
  resolve(token: string | null): Promise<ResolvedSession>;
  login(input: LoginInput): Promise<IssuedSession>;
  /** Creates a session for an already-authenticated user. Only `login` (and test harnesses) call it. */
  issueSession(userId: string): Promise<IssuedSession>;
  logout(sessionId: string): Promise<void>;
  /**
   * Revokes every live session of a user (optionally keeping one). This is the hook for password change, security
   * reset, account deletion or an administrator action: none of them may leave old sessions valid.
   */
  revokeAllForUser(userId: string, options?: { readonly exceptSessionId?: string }): Promise<number>;
  /** Does the presented CSRF token belong to this session's secret? Constant-time. */
  verifyCsrf(session: { readonly csrfToken: string }, presented: string | null): boolean;
}

export interface AuthServiceDeps {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly hasher: PasswordHasher;
  readonly secrets: SessionSecrets;
  readonly limiter: LoginRateLimiter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly transactions: UnitOfWork;
  readonly policy: Pick<SecurityPolicy, 'session' | 'password'>;
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { users, sessions, hasher, secrets, limiter, clock, ids, transactions, policy } = deps;

  // A real hash of a random password: verifying against it costs what a real verification costs, so an unknown
  // identifier is not measurably faster than a wrong password (reduced, not eliminated — see SECURITY.md).
  let dummyHash: Promise<string> | undefined;
  const timingDummy = () => (dummyHash ??= hasher.hash(secrets.generate()));

  async function issueSession(userId: string): Promise<IssuedSession> {
    const now = clock.now();
    const secret = secrets.generate();
    const expiresAt = new Date(now.getTime() + policy.session.absoluteTtlSeconds * 1000);
    const sessionId = ids.next();
    await sessions.create({ id: sessionId, userId, secretFingerprint: secrets.fingerprint(secret), createdAt: now, expiresAt, lastSeenAt: now, revokedAt: null });
    return { token: secret, userId, sessionId, expiresAt, csrfToken: secrets.csrfToken(secret) };
  }

  return {
    issueSession,

    async resolve(token) {
      if (token === null) return { status: 'none' };
      const session = await sessions.findByFingerprint(secrets.fingerprint(token));
      if (session === null || session.revokedAt !== null) return { status: 'expired' };
      const now = clock.now().getTime();
      if (now >= session.expiresAt.getTime()) return { status: 'expired' };
      if (now - session.lastSeenAt.getTime() >= policy.session.idleTtlSeconds * 1000) return { status: 'expired' };
      // A session whose user disappeared is dead (user removal must not leave usable sessions behind).
      if ((await users.findById(session.userId)) === null) return { status: 'expired' };

      if (now - session.lastSeenAt.getTime() >= policy.session.touchIntervalSeconds * 1000) {
        await sessions.touch(session.id, new Date(now));
      }
      return { status: 'active', sessionId: session.id, userId: session.userId, expiresAt: session.expiresAt, csrfToken: secrets.csrfToken(token) };
    },

    async login(input) {
      const identifier = normaliseIdentifier(input.identifier);
      const attempt = { identifier: identifier ?? '', address: input.clientAddress };

      const decision = await limiter.check(attempt);
      if (!decision.allowed) throw new AppError('rate_limited', { retryAfterSeconds: decision.retryAfterSeconds });

      const user = identifier === null ? null : await users.findByIdentifier(identifier);
      const tooLong = [...input.password].length > policy.password.maxLength;
      // Always spend one hash verification, whether or not the user exists and whatever the input length.
      const verified = await hasher.verify(tooLong ? '' : input.password, user?.passwordHash ?? (await timingDummy()));

      if (user === null || !verified || tooLong) {
        await limiter.recordFailure(attempt);
        throw new AppError('invalid_credentials'); // one answer for: unknown user, wrong password, unusable input
      }
      await limiter.recordSuccess(attempt);

      // Fixation defence: the new session has a brand-new secret; whatever the browser presented is revoked.
      // ATOMIC: revoke the old and create the new together (never "old revoked, no new" or "two live sessions").
      const userId = user.id;
      return transactions.run(async () => {
        if (input.replacingSessionId !== null) await sessions.revoke(input.replacingSessionId, clock.now());
        return issueSession(userId);
      });
    },

    async loginWithMailbox(input) {
      const identifier = normaliseIdentifier(input.identifier);
      const attempt = { identifier: identifier ?? '', address: input.clientAddress };

      const decision = await limiter.check(attempt);
      if (!decision.allowed) throw new AppError('rate_limited', { retryAfterSeconds: decision.retryAfterSeconds });
      if (identifier === null) {
        await limiter.recordFailure(attempt);
        throw new AppError('invalid_request', { fields: [{ field: 'email', reason: 'invalid' }] });
      }

      // Network I/O first, outside any transaction: nothing is written for a mailbox the provider rejects.
      try {
        await input.verify();
      } catch (error) {
        await limiter.recordFailure(attempt);
        throw error;
      }
      await limiter.recordSuccess(attempt);

      const unusableHash = await hasher.hash(secrets.generate());
      return transactions.run(async () => {
        let user = await users.findByIdentifier(identifier);
        let isNew = false;
        if (user === null) {
          const now = clock.now();
          const created = { id: ids.next(), identifier, passwordHash: unusableHash, createdAt: now, updatedAt: now };
          if (await users.create(created)) {
            user = created;
            isNew = true;
          } else {
            user = await users.findByIdentifier(identifier); // lost a race with a concurrent first sign-in
          }
        }
        if (user === null) throw new AppError('service_unavailable');
        await input.attach({ userId: user.id, isNew });
        if (input.replacingSessionId !== null) await sessions.revoke(input.replacingSessionId, clock.now());
        return issueSession(user.id);
      });
    },

    logout: (sessionId) => sessions.revoke(sessionId, clock.now()),

    revokeAllForUser: (userId, options) => sessions.revokeAllForUser(userId, clock.now(), options?.exceptSessionId),

    verifyCsrf(session, presented) {
      return presented !== null && presented !== '' && secrets.equals(presented, session.csrfToken);
    },
  };
}

/**
 * Authentication and session rules at service level, on the real Argon2id hasher and hashed sessions, with a fake clock.
 */
import { describe, expect, it } from 'vitest';
import type { PasswordHasher } from './ports/security/index.ts';
import { checkPasswordPolicy } from './services/password-policy.ts';
import { normaliseIdentifier } from './services/identifier.ts';
import { Argon2PasswordHasher } from '../infrastructure/security/argon2-password-hasher.ts';
import { USER_A } from '../testing/fixtures.ts';
import { SEED_IDENTIFIERS, SEED_PASSWORD, createTestApplication } from '../testing/harness.ts';
import { AppError } from './index.ts';

const ADDRESS = '198.51.100.20';
const login = (app: Awaited<ReturnType<typeof createTestApplication>>, identifier: string, password: string, over: { address?: string; replacing?: string | null } = {}) =>
  app.services.auth.login({ identifier, password, clientAddress: over.address ?? ADDRESS, replacingSessionId: over.replacing ?? null });

const failure = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected a failure');
};

/** The real hasher, counting verifications (so tests can prove one is always spent). */
function countingHasher() {
  const real = new Argon2PasswordHasher();
  const calls = { hash: 0, verify: 0 };
  const hasher: PasswordHasher = {
    hash: (p) => (calls.hash++, real.hash(p)),
    verify: (p, h) => (calls.verify++, real.verify(p, h)),
  };
  return { hasher, calls };
}

describe('login', () => {
  it('creates a session for the right identifier and password', async () => {
    const app = await createTestApplication();
    const issued = await login(app, SEED_IDENTIFIERS.a, SEED_PASSWORD);
    expect(issued.userId).toBe(USER_A);
    expect(issued.expiresAt.getTime()).toBe(app.clock.now().getTime() + app.config.session.absoluteTtlSeconds * 1000);
    expect(await app.services.auth.resolve(issued.token)).toMatchObject({ status: 'active', userId: USER_A });
  });

  it('stores only a fingerprint of the session secret, never the secret', async () => {
    const app = await createTestApplication();
    const issued = await login(app, SEED_IDENTIFIERS.a, SEED_PASSWORD);
    const stored = JSON.stringify(app.memory.sessions.snapshot());
    expect(stored).not.toContain(issued.token);
    expect(stored).not.toContain(issued.csrfToken);
    expect(stored).toContain(app.secrets.fingerprint(issued.token));
  });

  it('normalises the identifier (case, surrounding space, full-width forms)', async () => {
    const app = await createTestApplication();
    for (const variant of ['A@KAYDET.TEST', '  a@kaydet.test  ', 'ａ＠ｋａｙｄｅｔ.ｔｅｓｔ']) {
      expect((await login(app, variant, SEED_PASSWORD, { address: `10.0.0.${variant.length}` })).userId, variant).toBe(USER_A);
    }
  });

  it('rotates: every login is a NEW session with a new secret, and the presented session is revoked', async () => {
    const app = await createTestApplication();
    const first = await login(app, SEED_IDENTIFIERS.a, SEED_PASSWORD);
    const second = await login(app, SEED_IDENTIFIERS.a, SEED_PASSWORD, { replacing: first.sessionId });
    expect(second.token).not.toBe(first.token);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.csrfToken).not.toBe(first.csrfToken);
    expect((await app.services.auth.resolve(first.token)).status).toBe('expired'); // the old one is dead
    expect((await app.services.auth.resolve(second.token)).status).toBe('active');
  });

  it('a session presented by an attacker cannot become the authenticated session (fixation)', async () => {
    const app = await createTestApplication();
    const attackerPlanted = 'attacker-chosen-session-secret-value-123456';
    await login(app, SEED_IDENTIFIERS.a, SEED_PASSWORD); // victim signs in; the browser held the planted value
    // The planted value was never a session, so it does not authenticate — before or after the victim logs in.
    expect((await app.services.auth.resolve(attackerPlanted)).status).toBe('expired');
  });

  it('gives ONE identical failure for unknown user, wrong password, blank and unusable identifiers', async () => {
    const app = await createTestApplication();
    const cases: Array<[string, string]> = [
      ['nobody@kaydet.test', SEED_PASSWORD],
      [SEED_IDENTIFIERS.a, 'wrong password!!'],
      ['has space@kaydet.test', SEED_PASSWORD],
      ['‮a@kaydet.test', SEED_PASSWORD],
      [SEED_IDENTIFIERS.a, 'x'.repeat(app.config.password.maxLength + 1)],
    ];
    const errors: AppError[] = [];
    for (const [i, [identifier, password]] of cases.entries()) errors.push(await failure(login(app, identifier, password, { address: `10.1.0.${i}` })));
    for (const error of errors) {
      expect(error.code).toBe('invalid_credentials');
      expect(error.options).toEqual({}); // no extras that could differ
    }
  });

  it('always spends one hash verification — also for an unknown user or an unusable identifier (timing)', async () => {
    const { hasher, calls } = countingHasher();
    const app = await createTestApplication({ ports: { hasher } });
    await failure(login(app, SEED_IDENTIFIERS.a, 'wrong password!!', { address: '10.2.0.1' }));
    const afterKnown = calls.verify;
    await failure(login(app, 'nobody@kaydet.test', 'wrong password!!', { address: '10.2.0.2' }));
    await failure(login(app, 'bad identifier', 'wrong password!!', { address: '10.2.0.3' }));
    expect(afterKnown).toBe(1);
    expect(calls.verify).toBe(3);
    expect(calls.hash).toBe(1); // the dummy hash is made once and reused
  });

  it('never puts the password in an error', async () => {
    const app = await createTestApplication();
    const password = 'my-very-secret-attempt-9876';
    const error = await failure(login(app, SEED_IDENTIFIERS.a, password));
    expect(JSON.stringify({ code: error.code, message: error.message, options: error.options })).not.toContain(password);
  });
});

describe('login throttling', () => {
  it('locks after repeated failures (per identifier) with a retry delay, without verifying blocked attempts', async () => {
    const { hasher, calls } = countingHasher();
    const app = await createTestApplication({ ports: { hasher } });
    const max = app.config.loginLimits.maxFailuresPerIdentifier;
    for (let i = 0; i < max; i++) await failure(login(app, SEED_IDENTIFIERS.a, 'wrong password!!', { address: `10.3.0.${i}` }));
    const verifiesBefore = calls.verify;
    const blocked = await failure(login(app, SEED_IDENTIFIERS.a, SEED_PASSWORD, { address: '10.3.9.9' })); // even the RIGHT password
    expect(blocked.code).toBe('rate_limited');
    expect(blocked.options.retryAfterSeconds).toBe(app.config.loginLimits.backoffBaseSeconds);
    expect(calls.verify).toBe(verifiesBefore); // not verified, so no free oracle while locked
  });

  it('answers identically for existing and non-existing identifiers (no account enumeration)', async () => {
    const app = await createTestApplication();
    const max = app.config.loginLimits.maxFailuresPerIdentifier;
    const outcome = async (identifier: string, address: string) => {
      for (let i = 0; i < max; i++) await failure(login(app, identifier, 'wrong password!!', { address: `${address}.${i}` }));
      return failure(login(app, identifier, 'wrong password!!', { address: `${address}.99` }));
    };
    const known = await outcome(SEED_IDENTIFIERS.a, '10.4.0');
    const unknown = await outcome('ghost@kaydet.test', '10.5.0');
    expect(known.code).toBe('rate_limited');
    expect(unknown.code).toBe('rate_limited');
    expect(unknown.options.retryAfterSeconds).toBe(known.options.retryAfterSeconds);
  });

  it('is temporary: the same credentials work after the cool-down', async () => {
    const app = await createTestApplication();
    for (let i = 0; i < app.config.loginLimits.maxFailuresPerIdentifier; i++) await failure(login(app, SEED_IDENTIFIERS.a, 'wrong password!!', { address: `10.6.0.${i}` }));
    expect((await failure(login(app, SEED_IDENTIFIERS.a, SEED_PASSWORD, { address: '10.6.9.9' }))).code).toBe('rate_limited');
    app.clock.advance((app.config.loginLimits.backoffBaseSeconds + 1) * 1000);
    expect((await login(app, SEED_IDENTIFIERS.a, SEED_PASSWORD, { address: '10.6.9.9' })).userId).toBe(USER_A);
  });

  it('per address: one source trying many identifiers is stopped; other addresses are unaffected', async () => {
    const app = await createTestApplication();
    const max = app.config.loginLimits.maxFailuresPerAddress;
    for (let i = 0; i < max; i++) await failure(login(app, `user-${i}@kaydet.test`, 'wrong password!!', { address: '203.0.113.50' }));
    expect((await failure(login(app, SEED_IDENTIFIERS.b, SEED_PASSWORD, { address: '203.0.113.50' }))).code).toBe('rate_limited');
    expect((await login(app, SEED_IDENTIFIERS.b, SEED_PASSWORD, { address: '203.0.113.51' })).userId).toBeDefined();
  });

  it('a successful login resets the identifier counter, so normal users are not punished for a few typos', async () => {
    const app = await createTestApplication();
    const max = app.config.loginLimits.maxFailuresPerIdentifier;
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < max - 1; i++) await failure(login(app, SEED_IDENTIFIERS.a, 'typo typo typo', { address: `10.7.${round}.${i}` }));
      await login(app, SEED_IDENTIFIERS.a, SEED_PASSWORD, { address: `10.7.${round}.99` });
    }
  });

  it('authenticated traffic is not throttled: the limiter guards sign-in only', async () => {
    const app = await createTestApplication();
    for (let i = 0; i < 100; i++) expect((await app.services.auth.resolve(app.tokens.a)).status).toBe('active');
  });
});

describe('session validation', () => {
  it('no cookie = none; unknown/garbage secret = expired', async () => {
    const app = await createTestApplication();
    expect(await app.services.auth.resolve(null)).toEqual({ status: 'none' });
    for (const bad of ['nope', 'x'.repeat(43), '']) expect((await app.services.auth.resolve(bad)).status, bad).toBe('expired');
  });

  it('expires at the ABSOLUTE lifetime, however active the user is', async () => {
    const app = await createTestApplication();
    const { absoluteTtlSeconds, idleTtlSeconds } = app.config.session;
    for (let elapsed = 0; elapsed + idleTtlSeconds / 2 < absoluteTtlSeconds; elapsed += idleTtlSeconds / 2) {
      app.clock.advance((idleTtlSeconds / 2) * 1000);
      expect((await app.services.auth.resolve(app.tokens.a)).status).toBe('active'); // activity keeps it alive…
    }
    app.clock.advance(idleTtlSeconds * 1000);
    expect((await app.services.auth.resolve(app.tokens.a)).status).toBe('expired'); // …but not past the absolute limit
  });

  it('expires after being IDLE, and activity slides the idle window', async () => {
    const app = await createTestApplication();
    const { idleTtlSeconds } = app.config.session;
    app.clock.advance((idleTtlSeconds - 60) * 1000);
    expect((await app.services.auth.resolve(app.tokens.a)).status).toBe('active'); // refreshes lastSeenAt
    app.clock.advance((idleTtlSeconds - 60) * 1000);
    expect((await app.services.auth.resolve(app.tokens.a)).status).toBe('active'); // still alive: window slid
    app.clock.advance((idleTtlSeconds + 1) * 1000);
    expect((await app.services.auth.resolve(app.tokens.a)).status).toBe('expired'); // idle too long
  });

  it('writes lastSeenAt at most once per touch interval', async () => {
    const app = await createTestApplication();
    const seen = () => app.memory.sessions.snapshot().find((s) => s.userId === USER_A)?.lastSeenAt.getTime();
    const start = seen();
    app.clock.advance(10_000);
    await app.services.auth.resolve(app.tokens.a);
    expect(seen()).toBe(start); // within the interval: no write
    app.clock.advance(app.config.session.touchIntervalSeconds * 1000);
    await app.services.auth.resolve(app.tokens.a);
    expect(seen()).toBe(app.clock.now().getTime());
  });

  it('a revoked session is dead immediately', async () => {
    const app = await createTestApplication();
    const active = await app.services.auth.resolve(app.tokens.a);
    if (active.status !== 'active') throw new Error('expected active');
    await app.services.auth.logout(active.sessionId);
    expect((await app.services.auth.resolve(app.tokens.a)).status).toBe('expired');
    await app.services.auth.logout(active.sessionId); // idempotent
  });

  it('a session whose user no longer exists is dead', async () => {
    const app = await createTestApplication();
    const ghost = await app.services.auth.issueSession('user-that-was-never-created');
    expect((await app.services.auth.resolve(ghost.token)).status).toBe('expired');
  });

  it('the CSRF token verifies for its own session only, constant-time, and is not the session secret', async () => {
    const app = await createTestApplication();
    const a = await app.services.auth.resolve(app.tokens.a);
    const b = await app.services.auth.resolve(app.tokens.b);
    if (a.status !== 'active' || b.status !== 'active') throw new Error('expected active');
    expect(a.csrfToken).not.toBe(app.tokens.a);
    expect(app.services.auth.verifyCsrf(a, a.csrfToken)).toBe(true);
    expect(app.services.auth.verifyCsrf(a, b.csrfToken)).toBe(false);
    expect(app.services.auth.verifyCsrf(a, app.tokens.a)).toBe(false); // the session secret is not a CSRF token
    expect(app.services.auth.verifyCsrf(a, null)).toBe(false);
    expect(app.services.auth.verifyCsrf(a, '')).toBe(false);
  });
});

describe('session revocation (logout, password change, security reset, account removal)', () => {
  it('revokeAllForUser ends every session of the user, optionally sparing the current one, and no one else’s', async () => {
    const app = await createTestApplication();
    const second = await app.services.auth.issueSession(USER_A);
    const third = await app.services.auth.issueSession(USER_A);
    const spared = await app.services.auth.resolve(third.token);
    if (spared.status !== 'active') throw new Error('expected active');

    expect(await app.services.auth.revokeAllForUser(USER_A, { exceptSessionId: spared.sessionId })).toBe(2);
    expect((await app.services.auth.resolve(app.tokens.a)).status).toBe('expired');
    expect((await app.services.auth.resolve(second.token)).status).toBe('expired');
    expect((await app.services.auth.resolve(third.token)).status).toBe('active');
    expect((await app.services.auth.resolve(app.tokens.b)).status).toBe('active'); // another user untouched
    expect(await app.services.auth.revokeAllForUser(USER_A)).toBe(1);
    expect(await app.services.auth.revokeAllForUser(USER_A)).toBe(0);
  });
});

describe('user administration and password policy', () => {
  it('creates users with a real hash: not the plaintext, and the password then logs in', async () => {
    const app = await createTestApplication();
    const { userId } = await app.services.users.createUser({ identifier: 'New.User@Kaydet.test', password: 'a perfectly fine passphrase' });
    const record = await app.memory.users.findById(userId);
    expect(record?.identifier).toBe('new.user@kaydet.test');
    expect(record?.passwordHash).not.toContain('a perfectly fine passphrase');
    expect(record?.passwordHash).toMatch(/^\$argon2id\$/);
    expect((await login(app, 'NEW.user@kaydet.test', 'a perfectly fine passphrase')).userId).toBe(userId);
  });

  it('enforces the password policy with field reasons that never echo the password', async () => {
    const app = await createTestApplication();
    const { minLength, maxLength } = app.config.password;
    const reject = async (password: string, reason: string) => {
      const error = await failure(app.services.users.createUser({ identifier: 'someone@kaydet.test', password }));
      expect(error.code).toBe('invalid_request');
      expect(error.options.fields).toEqual([{ field: 'password', reason }]);
      expect(JSON.stringify(error.options)).not.toContain(password.trim() === '' ? '\u0000' : password);
    };
    await reject('', 'blank');
    await reject('          ', 'blank');
    await reject('Qx9!k', 'too_short');
    await reject('x'.repeat(minLength - 1), 'too_short');
    await reject('y'.repeat(maxLength + 1), 'too_long');
    await expect(app.services.users.createUser({ identifier: 'ok@kaydet.test', password: 'z'.repeat(maxLength) })).resolves.toBeDefined();
  });

  it('rejects unusable and duplicate identifiers', async () => {
    const app = await createTestApplication();
    expect((await failure(app.services.users.createUser({ identifier: '', password: 'a perfectly fine passphrase' }))).options.fields).toEqual([{ field: 'identifier', reason: 'invalid' }]);
    const duplicate = await failure(app.services.users.createUser({ identifier: 'A@KAYDET.test', password: 'a perfectly fine passphrase' }));
    expect(duplicate.options.fields).toEqual([{ field: 'identifier', reason: 'taken' }]);
  });

  it('policy unit rules: length by characters, no composition rules, blank is blank', () => {
    const limits = { minLength: 10, maxLength: 20 };
    expect(checkPasswordPolicy('aaaaaaaaaa', limits)).toBeNull(); // no symbol/uppercase/digit requirement
    expect(checkPasswordPolicy('🔐🔐🔐🔐🔐🔐🔐🔐🔐🔐', limits)).toBeNull(); // 10 code points, 20 UTF-16 units
    expect(checkPasswordPolicy('🔐'.repeat(21), limits)).toBe('too_long');
    expect(checkPasswordPolicy('a'.repeat(9), limits)).toBe('too_short');
    expect(checkPasswordPolicy('\t \n', limits)).toBe('blank');
  });

  it('identifier normalisation unit rules', () => {
    expect(normaliseIdentifier('  Ali@Example.COM ')).toBe('ali@example.com');
    expect(normaliseIdentifier('ａｌｉ')).toBe('ali');
    for (const bad of ['', '   ', 'a b', 'a\tb', 'a\u0000b', 'a‮b', 'x'.repeat(321)]) expect(normaliseIdentifier(bad), JSON.stringify(bad)).toBeNull();
  });
});

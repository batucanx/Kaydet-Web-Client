/**
 * Kaydet authentication, cookies, CSRF/CORS and secret hygiene — through the real HTTP stack.
 * (Primitives are covered in infrastructure/security.test.ts, rules in application/auth-service.test.ts.)
 */
import { AccountSchema, ApiErrorResponseSchema, SessionSchema, api, buildPath } from '@kaydet/domain';
import type { ApiRouteName, RouteSpec } from '@kaydet/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { IDS, USER_A } from '../testing/fixtures.ts';
import { SEED_IDENTIFIERS, SEED_PASSWORD, createHarness } from '../testing/harness.ts';
import type { Harness } from '../testing/harness.ts';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  CORS_ALLOWED_ORIGINS: 'https://mail.example.com',
  DATABASE_PATH: '/var/lib/kaydet/kaydet.db',
  CREDENTIAL_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
};
const ORIGIN = 'https://mail.example.com';
const EVIL = 'https://evil.example.net';

const errorOf = (res: { json: unknown }) => ApiErrorResponseSchema.parse(res.json).error;
const withoutRequestId = (res: { json: unknown }) => {
  const { requestId: _requestId, ...rest } = errorOf(res);
  return rest;
};
const cookieOf = (res: { headers: Record<string, unknown> }): string => String(res.headers['set-cookie']);
const tokenIn = (setCookie: string): string => decodeURIComponent(/^[^=]+=([^;]*)/.exec(setCookie)?.[1] ?? '');

/** Sign in over HTTP from a given client address. */
const signIn = (harness: Harness, over: { identifier?: string; password?: string; address?: string; headers?: Record<string, string> } = {}) =>
  harness.app.inject({
    method: 'POST',
    url: '/api/session',
    remoteAddress: over.address ?? '198.51.100.7',
    headers: over.headers ?? {},
    payload: { identifier: over.identifier ?? SEED_IDENTIFIERS.a, password: over.password ?? SEED_PASSWORD },
  });

const anyPath = (name: ApiRouteName): string => {
  const spec: RouteSpec = api[name];
  return buildPath(spec, Object.fromEntries((spec.path.match(/:([A-Za-z]+)/g) ?? []).map((p) => [p.slice(1), p === ':token' ? 'a'.repeat(24) : 'x1'])));
};
const SESSION_ROUTES = (Object.keys(api) as ApiRouteName[]).filter((name) => api[name].auth === 'session');

describe('sign-in over HTTP', () => {
  it('answers with the contract Session DTO only — no secret, hash, internal id or key', async () => {
    h = await createHarness();
    const res = await signIn(h);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(SessionSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ authenticated: true, user: { id: USER_A }, expiresAt: expect.any(String) });
    const token = tokenIn(String(res.headers['set-cookie']));
    const stored = JSON.stringify(h.memory.sessions.snapshot());
    for (const forbidden of [token, h.secrets.fingerprint(token), h.secrets.csrfToken(token), SEED_PASSWORD, 'passwordHash', 'argon2']) {
      expect(res.body, forbidden).not.toContain(forbidden);
    }
    expect(stored).not.toContain(token);
  });

  it('sets an HttpOnly, SameSite=Lax cookie scoped to the API, with the absolute lifetime and no Domain', async () => {
    h = await createHarness();
    const res = await signIn(h);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^kaydet_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/api');
    expect(cookie).toContain(`Max-Age=${h.config.session.absoluteTtlSeconds}`);
    expect(cookie).not.toContain('Domain');
    expect(cookie).not.toContain('Secure'); // plain-HTTP development only
  });

  it('is Secure in production and SameSite=Strict when configured', async () => {
    h = await createHarness({ env: { ...PRODUCTION_ENV, SESSION_COOKIE_SAMESITE: 'strict' } });
    const cookie = String((await signIn(h, { headers: { origin: ORIGIN } })).headers['set-cookie']);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('the cookie works for protected routes; the CSRF header is a DIFFERENT value than the cookie', async () => {
    h = await createHarness();
    const res = await signIn(h);
    const token = tokenIn(String(res.headers['set-cookie']));
    const csrf = String(res.headers['x-csrf-token']);
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrf).not.toBe(token);
    expect((await h.request('GET', '/accounts', { as: token })).status).toBe(200);
    const session = await h.request('GET', '/session', { as: token });
    expect(session.headers['x-csrf-token']).toBe(csrf); // a page reload can re-learn it
    expect(session.json).toMatchObject({ authenticated: true, user: { id: USER_A } });
  });

  it('signed-out GET /session has no CSRF header', async () => {
    h = await createHarness();
    expect((await h.request('GET', '/session', { as: 'none' })).headers['x-csrf-token']).toBeUndefined();
  });

  it('a failed sign-in sets no cookie and gives the same answer for an unknown user and a wrong password', async () => {
    h = await createHarness();
    const wrong = await signIn(h, { password: 'not the password', address: '10.0.1.1' });
    const unknown = await signIn(h, { identifier: 'ghost@kaydet.test', address: '10.0.1.2' });
    for (const res of [wrong, unknown]) {
      expect(res.statusCode).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['x-csrf-token']).toBeUndefined();
      expect(errorOf({ json: res.json() }).code).toBe('invalid_credentials');
    }
    expect(withoutRequestId({ json: wrong.json() })).toEqual(withoutRequestId({ json: unknown.json() }));
  });

  it('validation errors never echo the submitted password', async () => {
    h = await createHarness();
    const marker = 'p'.repeat(2000) + 'MARKER-NEVER-ECHO';
    const res = await signIn(h, { password: marker });
    expect(res.statusCode).toBe(400); // longer than the contract allows
    expect(res.body).not.toContain('MARKER-NEVER-ECHO');
    const extra = await h.app.inject({ method: 'POST', url: '/api/session', payload: { identifier: 'x', password: 'SECRET-EXTRA-FIELD', role: 'admin' } });
    expect(extra.statusCode).toBe(400);
    expect(extra.body).not.toContain('SECRET-EXTRA-FIELD');
  });

  it('rotates: signing in again while presenting a session revokes the presented one', async () => {
    h = await createHarness();
    const first = tokenIn(String((await signIn(h)).headers['set-cookie']));
    const second = await h.app.inject({
      method: 'POST',
      url: '/api/session',
      remoteAddress: '198.51.100.7',
      headers: { cookie: `kaydet_session=${first}` },
      payload: { identifier: SEED_IDENTIFIERS.a, password: SEED_PASSWORD },
    });
    const secondToken = tokenIn(String(second.headers['set-cookie']));
    expect(secondToken).not.toBe(first);
    expect(errorOf(await h.request('GET', '/accounts', { as: first })).code).toBe('session_expired');
    expect((await h.request('GET', '/accounts', { as: secondToken })).status).toBe(200);
  });
});

describe('sign-out and revocation', () => {
  it('revokes the session on the SERVER and clears the cookie; the old cookie is useless afterwards (replay)', async () => {
    h = await createHarness();
    const token = tokenIn(String((await signIn(h)).headers['set-cookie']));
    expect((await h.request('GET', '/accounts', { as: token })).status).toBe(200);

    const out = await h.request('DELETE', '/session', { as: token });
    expect(out.status).toBe(204);
    expect(cookieOf(out)).toMatch(/^kaydet_session=;/);
    expect(cookieOf(out)).toContain('Max-Age=0');
    expect(cookieOf(out)).toContain('Path=/api');

    // A copy of the cookie (stolen earlier, or kept by a script) no longer works:
    const replay = await h.request('GET', '/accounts', { as: token });
    expect(replay.status).toBe(401);
    expect(errorOf(replay).code).toBe('session_expired');
    expect(h.memory.sessions.snapshot().find((s) => s.secretFingerprint === h.secrets.fingerprint(token))?.revokedAt).not.toBeNull();
    expect((await h.request('DELETE', '/session', { as: token })).status).toBe(401); // and cannot log out twice
  });

  it('a revoked session fails on EVERY protected route', async () => {
    h = await createHarness();
    const token = await h.issue(USER_A);
    const session = await h.services.auth.resolve(token);
    if (session.status !== 'active') throw new Error('expected active');
    await h.services.auth.logout(session.sessionId);
    for (const name of SESSION_ROUTES) {
      const res = await h.request(api[name].method, anyPath(name), { as: token });
      expect(res.status, name).toBe(401);
      expect(errorOf(res).code, name).toBe('session_expired');
    }
  });

  it('revoking all sessions of a user (password change / reset) ends them all at once', async () => {
    h = await createHarness();
    const other = await h.issue(USER_A);
    expect(await h.services.auth.revokeAllForUser(USER_A)).toBe(2);
    for (const token of [h.tokens.a, other]) expect(errorOf(await h.request('GET', '/accounts', { as: token })).code).toBe('session_expired');
    expect((await h.request('GET', '/accounts', { as: 'b' })).status).toBe(200);
  });

  it('an absolute-expired and an idle-expired session fail on EVERY protected route', async () => {
    h = await createHarness();
    const idle = await h.issue(USER_A);
    h.clock.advance((h.config.session.idleTtlSeconds + 1) * 1000);
    for (const name of SESSION_ROUTES) {
      const res = await h.request(api[name].method, anyPath(name), { as: idle });
      expect(res.status, `idle ${name}`).toBe(401);
      expect(errorOf(res).code).toBe('session_expired');
    }

    // Absolute: keep it active by touching it, then pass the absolute limit.
    const long = await h.issue(USER_A);
    const step = Math.floor(h.config.session.idleTtlSeconds / 2) * 1000;
    for (let i = 0; i * step < h.config.session.absoluteTtlSeconds * 1000; i++) {
      h.clock.advance(step);
      await h.request('GET', '/session', { as: long });
    }
    for (const name of SESSION_ROUTES) {
      const res = await h.request(api[name].method, anyPath(name), { as: long });
      expect(res.status, `absolute ${name}`).toBe(401);
    }
  });
});

describe('brute-force protection over HTTP', () => {
  it('answers 429 rate_limited with Retry-After after repeated failures, even for the right password, then recovers', async () => {
    h = await createHarness();
    const max = h.config.loginLimits.maxFailuresPerIdentifier;
    for (let i = 0; i < max; i++) expect((await signIn(h, { password: 'wrong password!!', address: `10.9.0.${i}` })).statusCode).toBe(401);

    const blocked = await signIn(h, { address: '10.9.1.1' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe(String(h.config.loginLimits.backoffBaseSeconds));
    expect(errorOf({ json: blocked.json() })).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterSeconds: h.config.loginLimits.backoffBaseSeconds });
    expect(blocked.headers['set-cookie']).toBeUndefined();

    h.clock.advance((h.config.loginLimits.backoffBaseSeconds + 1) * 1000);
    expect((await signIn(h, { address: '10.9.1.1' })).statusCode).toBe(201);
  });

  it('is indistinguishable for existing and non-existing accounts', async () => {
    h = await createHarness();
    const max = h.config.loginLimits.maxFailuresPerIdentifier;
    const lock = async (identifier: string, net: string) => {
      for (let i = 0; i < max; i++) await signIn(h, { identifier, password: 'wrong password!!', address: `${net}.${i}` });
      return signIn(h, { identifier, password: 'wrong password!!', address: `${net}.200` });
    };
    const known = await lock(SEED_IDENTIFIERS.a, '10.10.0');
    const unknown = await lock('ghost@kaydet.test', '10.11.0');
    expect(known.statusCode).toBe(429);
    expect(unknown.statusCode).toBe(429);
    expect(withoutRequestId({ json: known.json() })).toEqual(withoutRequestId({ json: unknown.json() }));
    expect(known.headers['retry-after']).toBe(unknown.headers['retry-after']);
  });

  it('normal authenticated traffic is never blocked by the sign-in limiter', async () => {
    h = await createHarness();
    for (let i = 0; i < 60; i++) expect((await h.request('GET', '/accounts')).status).toBe(200);
  });

  it('uses the client address the server sees (X-Forwarded-For is ignored unless TRUST_PROXY)', async () => {
    h = await createHarness();
    const max = h.config.loginLimits.maxFailuresPerAddress;
    for (let i = 0; i < max; i++) {
      await h.app.inject({ method: 'POST', url: '/api/session', remoteAddress: '203.0.113.99', headers: { 'x-forwarded-for': `10.20.${i}.1` }, payload: { identifier: `u${i}@kaydet.test`, password: 'wrong password!!' } });
    }
    const blocked = await signIn(h, { address: '203.0.113.99', identifier: SEED_IDENTIFIERS.b });
    expect(blocked.statusCode).toBe(429); // spoofed X-Forwarded-For did not dodge the per-address limit
  });
});

describe('CSRF and CORS (two separate mechanisms)', () => {
  const env = { CORS_ALLOWED_ORIGINS: ORIGIN };

  it('authenticated GET from an allowed origin works and is readable cross-origin (CORS)', async () => {
    h = await createHarness({ env });
    const res = await h.request('GET', '/accounts', { headers: { origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('a disallowed origin gets no CORS headers (the browser will not expose the response)', async () => {
    h = await createHarness({ env });
    const res = await h.request('GET', '/accounts', { headers: { origin: EVIL } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('the CSRF header is allowed and exposed for the allowed origin only', async () => {
    h = await createHarness({ env });
    const preflight = (origin: string) =>
      h.app.inject({ method: 'OPTIONS', url: '/api/messages/actions', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-csrf-token' } });
    const ok = await preflight(ORIGIN);
    expect(ok.headers['access-control-allow-headers']).toMatch(/x-csrf-token/i);
    expect((await preflight(EVIL)).headers['access-control-allow-origin']).toBeUndefined();
    const exposed = await h.request('GET', '/session', { headers: { origin: ORIGIN } });
    expect(String(exposed.headers['access-control-expose-headers'])).toMatch(/X-CSRF-Token/i);
  });

  it('a state-changing request WITHOUT a CSRF token is rejected (403 forbidden), before any effect', async () => {
    h = await createHarness({ env });
    const before = h.memory.store.templates.length;
    const res = await h.request('PUT', '/templates/t1', { csrf: false, headers: { origin: ORIGIN }, body: { title: 'x', content: 'y' } });
    expect(res.status).toBe(403);
    expect(errorOf(res)).toMatchObject({ code: 'forbidden', kind: 'authorization', fields: [{ field: 'x-csrf-token', reason: 'missing' }] });
    expect(h.memory.store.templates.length).toBe(before);
  });

  it('accepts a state-changing request with the valid token', async () => {
    h = await createHarness({ env });
    const res = await h.request('PUT', '/templates/t1', { headers: { origin: ORIGIN }, body: { title: 'x', content: 'y' } });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong token, another session’s token, and the session secret itself', async () => {
    h = await createHarness({ env });
    const body = { title: 'x', content: 'y' };
    const attempts: Record<string, string> = {
      wrong: 'not-the-token',
      'other user’s token': h.secrets.csrfToken(h.tokens.b),
      'session secret': h.tokens.a,
      'session fingerprint': h.secrets.fingerprint(h.tokens.a),
    };
    for (const [name, csrf] of Object.entries(attempts)) {
      const res = await h.request('PUT', '/templates/t1', { csrf, body });
      expect(res.status, name).toBe(403);
      expect(errorOf(res).fields).toEqual([{ field: 'x-csrf-token', reason: 'invalid' }]);
    }
  });

  it('the token dies with its session: after sign-in rotation the old token is refused', async () => {
    h = await createHarness({ env });
    const oldCsrf = h.secrets.csrfToken(h.tokens.a);
    const fresh = await h.issue(USER_A);
    const res = await h.request('PUT', '/templates/t1', { as: fresh, csrf: oldCsrf, body: { title: 'x', content: 'y' } });
    expect(res.status).toBe(403);
  });

  it('MALICIOUS ORIGIN: a cross-site request carrying the cookie (and even a valid token) is refused', async () => {
    h = await createHarness({ env });
    const before = h.memory.store.templates.length;
    const withCookieOnly = await h.request('PUT', '/templates/t1', { csrf: false, headers: { origin: EVIL }, body: { title: 'x', content: 'y' } });
    expect(withCookieOnly.status).toBe(403);
    expect(errorOf(withCookieOnly).fields).toEqual([{ field: 'origin', reason: 'not_allowed' }]);
    const withToken = await h.request('PUT', '/templates/t1', { headers: { origin: EVIL }, body: { title: 'x', content: 'y' } });
    expect(withToken.status).toBe(403); // defence in depth: the origin check does not depend on the token
    const nullOrigin = await h.request('DELETE', `/accounts/${IDS.a1}`, { headers: { origin: 'null' } });
    expect(nullOrigin.status).toBe(403);
    expect(h.memory.store.templates.length).toBe(before);
    expect(h.memory.store.accounts.some((a) => a.account.id === IDS.a1)).toBe(true);
  });

  it('sign-in is protected against login CSRF by the Origin check', async () => {
    h = await createHarness({ env });
    const evil = await signIn(h, { headers: { origin: EVIL } });
    expect(evil.statusCode).toBe(403);
    expect(evil.headers['set-cookie']).toBeUndefined();
    expect((await signIn(h, { headers: { origin: ORIGIN } })).statusCode).toBe(201);
  });

  it('CORS alone is not treated as CSRF protection: an ALLOWED origin still needs the token', async () => {
    h = await createHarness({ env });
    const res = await h.request('DELETE', `/accounts/${IDS.a2}`, { csrf: false, headers: { origin: ORIGIN } });
    expect(res.status).toBe(403);
  });

  it('every state-changing session route demands the token; safe methods do not', async () => {
    h = await createHarness();
    for (const name of SESSION_ROUTES) {
      const spec = api[name];
      const res = await h.request(spec.method, anyPath(name), { csrf: false });
      if (spec.method === 'GET') expect(res.status, name).not.toBe(403);
      else {
        expect(res.status, name).toBe(403);
        expect(errorOf(res).code, name).toBe('forbidden');
      }
    }
  });

  it('the CSRF check happens before the body is read (an oversized body is not buffered for a forged request)', async () => {
    h = await createHarness({ env: { MAX_JSON_BODY_BYTES: '1024' } });
    const res = await h.request('PUT', '/templates/t1', { csrf: false, body: { title: 't', content: 'x'.repeat(5000) } });
    expect(res.status).toBe(403);
  });
});

describe('headers', () => {
  it('keeps the Phase 3 security headers on authentication responses', async () => {
    h = await createHarness();
    for (const res of [await signIn(h), await signIn(h, { password: 'wrong password!!', address: '10.30.0.1' })]) {
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    }
  });
});

describe('mail credentials over HTTP', () => {
  const MARKER = 'HTTP-IMAP-PASSWORD-MARKER-91b2';
  const USER_MARKER = 'http-imap-user-marker@provider.example';
  const body = (over: Record<string, unknown> = {}) => ({
    email: 'me@provider.example',
    displayName: 'Ben',
    username: USER_MARKER,
    password: MARKER,
    imap: { host: 'imap.http-host-marker.example', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.http-host-marker.example', port: 465, security: 'ssl' },
    ...over,
  });

  it('creates and updates accounts; no response, event, log line or stored envelope contains a credential', async () => {
    h = await createHarness({ env: { LOG_LEVEL: 'trace' } });
    const created = await h.request('POST', '/accounts', { body: body() });
    expect(created.status).toBe(201);
    expect(AccountSchema.safeParse(created.json).success).toBe(true);
    const id = (created.json as { id: string }).id;

    const responses = [
      created,
      await h.request('GET', '/accounts'),
      await h.request('PATCH', `/accounts/${id}`, { body: { password: `${MARKER}-NEW`, displayName: 'Yeni' } }),
      await h.request('PATCH', `/accounts/${id}`, { body: { imap: { host: 'imap.http-host-marker2.example', port: 993, security: 'ssl' } } }),
      await h.request('POST', '/accounts', { body: body() }), // duplicate → account_exists
      await h.request('POST', '/accounts', { body: body({ imap: { host: 'x', port: 99999, security: 'ssl' } }) }), // invalid → 400
      await h.request('PATCH', `/accounts/${IDS.b1}`, { body: { password: MARKER } }), // foreign → 404
    ];
    expect(responses.map((r) => r.status)).toEqual([201, 200, 200, 200, 409, 400, 404]);

    const stored = JSON.stringify([...h.memory.credentialRecords.snapshot().values()]);
    const everything = [...responses.map((r) => r.text), JSON.stringify(h.events.published), h.logLines.join('\n'), stored].join('\n');
    for (const marker of [MARKER, USER_MARKER, 'http-host-marker']) expect(everything, marker).not.toContain(marker);
    expect(h.logLines.length).toBeGreaterThan(5); // the logs really were captured at trace level
  });

  it('requires a session and the CSRF token, and a foreign account answers account_not_found', async () => {
    h = await createHarness();
    expect((await h.request('POST', '/accounts', { as: 'none', body: body() })).status).toBe(401);
    expect((await h.request('POST', '/accounts', { csrf: false, body: body() })).status).toBe(403);
    const before = h.memory.credentialRecords.snapshot().size;
    expect((await h.request('PATCH', `/accounts/${IDS.b1}`, { body: { password: 'attacker-secret-value' } })).status).toBe(404);
    expect(h.memory.credentialRecords.snapshot().size).toBe(before);
  });
});

describe('logging security', () => {
  it('a full authentication session never puts secrets or identifiers in the logs', async () => {
    h = await createHarness({ env: { LOG_LEVEL: 'trace' } });
    const good = await signIn(h);
    const token = tokenIn(String(good.headers['set-cookie']));
    const csrf = String(good.headers['x-csrf-token']);
    await signIn(h, { password: 'attempt-that-is-wrong-9', address: '10.40.0.1' });
    await signIn(h, { identifier: 'ghost@kaydet.test', address: '10.40.0.2' });
    await h.request('PUT', '/templates/t1', { as: token, csrf: 'forged-csrf-value', body: { title: 'x', content: 'y' } });
    await h.request('GET', '/accounts', { as: 'unknown-session-secret-value' });
    await h.request('DELETE', '/session', { as: token });

    const user = await h.memory.users.findById(USER_A);
    const output = h.logLines.join('\n');
    expect(output.length).toBeGreaterThan(0);
    for (const forbidden of [
      SEED_PASSWORD, 'attempt-that-is-wrong-9', user?.passwordHash ?? 'x', token, h.secrets.fingerprint(token), csrf, 'forged-csrf-value',
      'unknown-session-secret-value', SEED_IDENTIFIERS.a, 'ghost@kaydet.test',
    ]) {
      expect(output, forbidden).not.toContain(forbidden);
    }
    // What IS logged: request ids, codes, statuses, route patterns.
    expect(output).toContain('invalid_credentials');
    expect(output).toContain('sign-in succeeded');
    expect(output).not.toMatch(/set-cookie|"cookie"|bearer /i); // headers are not logged (`"kind":"authorization"` is an error kind, not a header)
  });
});

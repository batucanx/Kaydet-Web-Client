import { ApiErrorResponseSchema, api } from '@kaydet/domain';
import type { ApiRouteName } from '@kaydet/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../application/index.ts';
import { accountsWith, createHarness } from '../testing/harness.ts';
import type { Harness } from '../testing/harness.ts';
import { IDS } from '../testing/fixtures.ts';

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  CORS_ALLOWED_ORIGINS: 'https://mail.example.com',
  DATABASE_PATH: '/var/lib/kaydet/kaydet.db',
  CREDENTIAL_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
};

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('health and readiness', () => {
  it('GET /health answers without authentication and outside the API prefix', async () => {
    h = await createHarness();
    const res = await h.request('GET', '/health', { as: 'none' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'ok' });
  });

  it('GET /ready answers ready when nothing required is missing', async () => {
    h = await createHarness();
    const res = await h.request('GET', '/ready', { as: 'none' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'ready' });
  });

  it('the contract routes are not served without the prefix', async () => {
    h = await createHarness();
    const res = await h.app.inject({ method: 'GET', url: '/session' });
    expect(res.statusCode).toBe(404);
  });
});

describe('route table', () => {
  it('registers every route of the contract with its method and path', async () => {
    h = await createHarness();
    for (const name of Object.keys(api) as ApiRouteName[]) {
      const spec = api[name];
      expect(h.app.hasRoute({ method: spec.method, url: `${h.config.apiPrefix}${spec.path}` }), `${name} ${spec.method} ${spec.path}`).toBe(true);
    }
  });
});

describe('request ids', () => {
  it('generates one per request, returns it in a header and puts the same id in error bodies', async () => {
    h = await createHarness();
    const res = await h.request('GET', '/accounts', { as: 'none' });
    const id = res.headers['x-request-id'];
    expect(typeof id).toBe('string');
    expect(ApiErrorResponseSchema.parse(res.json).error.requestId).toBe(id);
    const other = await h.request('GET', '/health', { as: 'none' });
    expect(other.headers['x-request-id']).not.toBe(id);
  });

  it('keeps a well-formed inbound X-Request-Id and replaces a malformed one', async () => {
    h = await createHarness();
    const kept = await h.request('GET', '/health', { as: 'none', headers: { 'x-request-id': 'trace-1234.abcd' } });
    expect(kept.headers['x-request-id']).toBe('trace-1234.abcd');
    const replaced = await h.request('GET', '/health', { as: 'none', headers: { 'x-request-id': 'bad id\twith spaces & <script>' } });
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('request validation at the HTTP boundary', () => {
  it('rejects an invalid body with invalid_request and a field list, without echoing values', async () => {
    h = await createHarness();
    const res = await h.request('POST', `/accounts/${IDS.a1}/labels`, { body: { name: '', tone: 99, extra: 'SECRET-VALUE' } });
    expect(res.status).toBe(400);
    const error = ApiErrorResponseSchema.parse(res.json).error;
    expect(error.code).toBe('invalid_request');
    expect(error.fields?.map((f) => f.field)).toEqual(expect.arrayContaining(['body.name', 'body.tone', 'body']));
    expect(res.text).not.toContain('SECRET-VALUE');
  });

  it('rejects unknown fields where the contract is strict', async () => {
    h = await createHarness();
    const res = await h.request('PUT', '/templates/t1', { body: { title: 'x', content: 'y', isBuiltIn: true } });
    expect(res.status).toBe(400);
    expect((res.json as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  it('rejects an invalid query (scope=folder without folderId, out-of-range limit)', async () => {
    h = await createHarness();
    const missing = await h.request('GET', `/accounts/${IDS.a1}/messages`, { query: { scope: 'folder' } });
    expect(missing.status).toBe(400);
    const limit = await h.request('GET', `/accounts/${IDS.a1}/messages`, { query: { scope: 'pinned', limit: '1000' } });
    expect(limit.status).toBe(400);
    const repeated = await h.app.inject({
      method: 'GET',
      url: `/api/accounts/${IDS.a1}/messages?scope=pinned&scope=folder`,
      headers: { cookie: `${h.config.cookie.name}=${h.tokens.a}` },
    });
    expect(repeated.statusCode).toBe(400);
  });

  it('validates path parameters (an over-long id is invalid, not looked up)', async () => {
    h = await createHarness();
    const res = await h.request('GET', `/messages/${'x'.repeat(300)}`);
    expect(res.status).toBe(400);
    expect((res.json as { error: { fields: Array<{ field: string }> } }).error.fields[0]?.field).toBe('params.messageId');
  });

  it('rejects malformed JSON and unsupported media types in the contract error shape', async () => {
    h = await createHarness();
    const headers = { cookie: `${h.config.cookie.name}=${h.tokens.a}`, 'x-csrf-token': h.secrets.csrfToken(h.tokens.a) };
    const bad = await h.app.inject({ method: 'POST', url: `/api/accounts/${IDS.a1}/labels`, headers: { ...headers, 'content-type': 'application/json' }, payload: '{"name":' });
    expect(bad.statusCode).toBe(400);
    expect(ApiErrorResponseSchema.parse(bad.json()).error.code).toBe('invalid_request');
    const media = await h.app.inject({ method: 'POST', url: `/api/accounts/${IDS.a1}/labels`, headers: { ...headers, 'content-type': 'application/xml' }, payload: '<x/>' });
    expect(media.statusCode).toBe(415);
    expect(ApiErrorResponseSchema.parse(media.json()).error.code).toBe('invalid_request');
  });

  it('enforces the body size limit (413) before the handler runs', async () => {
    h = await createHarness({ env: { MAX_JSON_BODY_BYTES: '1024' } });
    const res = await h.request('PUT', '/templates/t1', { body: { title: 't', content: 'x'.repeat(5000) } });
    expect(res.status).toBe(413);
    expect(ApiErrorResponseSchema.parse(res.json).error.code).toBe('invalid_request');
  });

  it('uses the larger draft limit only for the draft upsert', async () => {
    h = await createHarness({ env: { MAX_JSON_BODY_BYTES: '1024', MAX_DRAFT_BODY_BYTES: '65536' } });
    const draft = { accountId: IDS.a1, to: [], cc: [], bcc: [], subject: '', bodyText: 'x'.repeat(5000), bodyHtml: null, attachmentIds: [], source: null };
    expect((await h.request('PUT', '/drafts/d1', { body: draft })).status).toBe(200);
  });
});

describe('unknown routes and methods', () => {
  it('answers 404 in the contract error shape', async () => {
    h = await createHarness();
    for (const [method, url] of [['GET', '/nope'], ['GET', '/accounts/a/unknown'], ['PATCH', '/session']] as const) {
      const res = await h.request(method, url, { as: 'none' });
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(ApiErrorResponseSchema.parse(res.json).error.code).toBe('invalid_request');
    }
  });
});

describe('centralized error mapping', () => {
  it('maps an AppError to its contract code, status, kind, retry policy and safe message', async () => {
    h = await createHarness({
      ports: {
        accounts: accountsWith({ listByUser: () => Promise.reject(new AppError('rate_limited', { retryAfterSeconds: 7 })) }),
      },
    });
    const res = await h.request('GET', '/accounts');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('7');
    expect(ApiErrorResponseSchema.parse(res.json).error).toMatchObject({ code: 'rate_limited', kind: 'network', retryable: true, retryAfterSeconds: 7 });
  });

  it('turns an unexpected failure into internal_error: logged server-side, never exposed', async () => {
    const secret = 'connect ECONNREFUSED db.internal:5432 password=hunter2';
    h = await createHarness({
      env: { LOG_LEVEL: 'info' },
      ports: {
        accounts: accountsWith({ listByUser: () => Promise.reject(new Error(secret)) }),
      },
    });
    const res = await h.request('GET', '/accounts');
    expect(res.status).toBe(500);
    const error = ApiErrorResponseSchema.parse(res.json).error;
    expect(error).toMatchObject({ code: 'internal_error', kind: 'operation_permanent' });
    expect(res.text).not.toContain('hunter2');
    expect(res.text).not.toContain('ECONNREFUSED');
    expect(res.text).not.toContain('stack');

    const line = h.logs().find((l) => l['msg'] === 'request failed');
    expect(line).toBeDefined();
    expect(line?.['requestId']).toBe(error.requestId);
    expect(line?.['code']).toBe('internal_error');
    expect(line?.['operation']).toBe('accounts.list');
    expect(JSON.stringify(line)).toContain('ECONNREFUSED'); // the detail is in the server log, and only there
  });

  it('hides provider details: a provider failure carries its code and safe message only', async () => {
    h = await createHarness({
      ports: {
        mailbox: {
          requestSync: () => Promise.reject(new AppError('provider_unreachable', { cause: new Error('imap.secret-host.example:993 ETIMEDOUT') })),
          createFolder: () => Promise.reject(new Error('unused')),
          updateFolder: () => Promise.reject(new Error('unused')),
          deleteFolder: () => Promise.reject(new Error('unused')),
          applyActions: () => Promise.reject(new Error('unused')),
          undo: () => Promise.resolve({ restored: false }),
        },
      },
    });
    const res = await h.request('POST', `/accounts/${IDS.a1}/sync`);
    expect(res.status).toBe(502);
    expect(ApiErrorResponseSchema.parse(res.json).error).toMatchObject({ code: 'provider_unreachable', kind: 'provider', retryable: true });
    expect(res.text).not.toContain('secret-host');
  });

  it('every route error uses the same envelope', async () => {
    h = await createHarness();
    const samples = [
      await h.request('GET', '/accounts', { as: 'none' }),
      await h.request('GET', `/accounts/nope/folders`),
      await h.request('POST', `/accounts/${IDS.a1}/sync`),
      await h.request('GET', '/messages/x', { as: 'none' }),
    ];
    for (const res of samples) expect(ApiErrorResponseSchema.safeParse(res.json).success, res.text).toBe(true);
  });
});

describe('response contract validation', () => {
  it('refuses to send a response that violates the contract (backend drift) and reports it as internal_error', async () => {
    h = await createHarness({
      env: { LOG_LEVEL: 'info' },
      ports: {
        accounts: accountsWith({
          // An IMAP-ish field leaking into an account DTO must be caught by the strict response schema.
          listByUser: () => Promise.resolve([{ id: 'a', email: 'a@x.io', displayName: '', supportsServerLabels: null, sync: { status: 'idle', lastSyncAt: null }, imapUid: 42 } as never]),
        }),
      },
    });
    const res = await h.request('GET', '/accounts');
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('imapUid');
    expect(h.logs().some((l) => JSON.stringify(l).includes('response violates contract'))).toBe(true);
  });

  it('is off when configured off (production default): the payload is sent as produced', async () => {
    h = await createHarness({
      env: { VALIDATE_RESPONSES: 'false' },
      ports: {
        accounts: accountsWith({ listByUser: () => Promise.resolve([{ id: 'a' } as never]) }),
      },
    });
    expect((await h.request('GET', '/accounts')).status).toBe(200);
  });
});

describe('security headers and CORS', () => {
  it('sets hardening headers on every response, including errors', async () => {
    h = await createHarness();
    for (const res of [await h.request('GET', '/health', { as: 'none' }), await h.request('GET', '/accounts', { as: 'none' })]) {
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['strict-transport-security']).toBeUndefined(); // production only
    }
  });

  it('adds HSTS in production', async () => {
    h = await createHarness({ env: PRODUCTION_ENV });
    expect((await h.request('GET', '/health', { as: 'none' })).headers['strict-transport-security']).toContain('max-age=');
  });

  it('allows only configured origins, with credentials, and never a wildcard', async () => {
    h = await createHarness({ env: { CORS_ALLOWED_ORIGINS: 'https://mail.example.com' } });
    const allowed = await h.request('GET', '/health', { as: 'none', headers: { origin: 'https://mail.example.com' } });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://mail.example.com');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(allowed.headers['vary']).toContain('Origin');

    const evil = await h.request('GET', '/health', { as: 'none', headers: { origin: 'https://evil.example.com' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    expect(evil.headers['access-control-allow-credentials']).toBeUndefined();

    const same = await h.request('GET', '/health', { as: 'none' });
    expect(same.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflights for allowed origins only, without touching authentication', async () => {
    h = await createHarness({ env: { CORS_ALLOWED_ORIGINS: 'https://mail.example.com' } });
    const preflight = (origin: string) =>
      h.app.inject({
        method: 'OPTIONS',
        url: '/api/messages/actions',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
      });
    const ok = await preflight('https://mail.example.com');
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('https://mail.example.com');
    expect(ok.headers['access-control-allow-methods']).toContain('POST');
    const denied = await preflight('https://evil.example.com');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('has no cross-origin access by default in test mode', async () => {
    h = await createHarness();
    const res = await h.request('GET', '/health', { as: 'none', headers: { origin: 'http://localhost:5173' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('observability', () => {
  it('writes one structured access line per request with requestId, method, route pattern, status and duration', async () => {
    h = await createHarness({ env: { LOG_LEVEL: 'info' } });
    const res = await h.request('GET', `/accounts/${IDS.a1}/folders`, { headers: { 'x-request-id': 'req-abcdef01' } });
    expect(res.status).toBe(200);
    const line = h.logs().find((l) => l['msg'] === 'request completed');
    expect(line).toMatchObject({ requestId: 'req-abcdef01', method: 'GET', route: '/api/accounts/:accountId/folders', status: 200 });
    expect(typeof line?.['durationMs']).toBe('number');
  });

  it('never logs credentials, session tokens, query strings or ids from paths', async () => {
    h = await createHarness({ env: { LOG_LEVEL: 'trace' } });
    await h.request('GET', '/search', { query: { q: 'gizli arama terimi', accounts: 'all' } });
    await h.request('GET', `/messages/${IDS.m1}`);
    await h.request('GET', '/accounts', { as: 'expired-secret-token' });
    const output = h.logLines.join('\n');
    expect(output).not.toContain(h.tokens.a);
    expect(output).not.toContain('expired-secret-token');
    expect(output).not.toContain('gizli arama');
    expect(output).not.toContain(IDS.m1);
  });
});

describe('deferred infrastructure answers honestly', () => {
  it('provider-backed routes answer service_unavailable while no mail adapter exists (default wiring)', async () => {
    h = await createHarness();
    for (const [method, url, body] of [
      ['POST', `/accounts/${IDS.a1}/sync`, undefined],
      ['POST', `/accounts/${IDS.a1}/folders`, { name: 'Yeni', parentId: null }],
      ['POST', '/messages/actions', { accountId: IDS.a1, messageIds: [IDS.m1], actions: [{ type: 'markRead' }] }],
      ['GET', '/events', undefined],
    ] as const) {
      const res = await h.request(method, url, body === undefined ? {} : { body });
      expect(res.status, `${method} ${url}`).toBe(503);
      expect(ApiErrorResponseSchema.parse(res.json).error.code).toBe('service_unavailable');
    }
  });
});

describe('graceful shutdown', () => {
  it('closes the event bus when the app closes', async () => {
    h = await createHarness();
    let received = 0;
    h.events.subscribe(() => (received += 1));
    h.events.publish('user-a', { type: 'accounts.changed' });
    expect(received).toBe(1);
    await h.app.close();
    h.events.publish('user-a', { type: 'accounts.changed' });
    expect(received).toBe(1); // the bus was closed by the onClose hook
  });
});

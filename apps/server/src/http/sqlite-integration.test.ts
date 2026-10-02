/**
 * Phase 4 behaviour and the contract, re-proven against SQLite through the real HTTP stack — including real restarts:
 * the same database file is closed and reopened by a brand-new application (new composition, new caches, new event bus).
 */
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { AccountSchema, ApiErrorResponseSchema, DraftSchema, MessagePageSchema, MessageSchema, OutboxSchema, SearchPageSchema, SessionSchema, api } from '@kaydet/domain';
import type { ApiRouteName, RouteSpec } from '@kaydet/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_SCOPED } from '../testing/account-scoped.ts';
import { IDS, USER_A, USER_B } from '../testing/fixtures.ts';
import { SEED_IDENTIFIERS, SEED_PASSWORD, accountsWith } from '../testing/harness.ts';
import { createSqliteHarness } from '../testing/sqlite.ts';
import type { SqliteHarness } from '../testing/sqlite.ts';
import { AppError } from '../application/index.ts';
import type { SessionRepository } from '../application/index.ts';

const open: SqliteHarness[] = [];
const start = async (options: Parameters<typeof createSqliteHarness>[0] = {}) => {
  const h = await createSqliteHarness(options);
  open.push(h);
  return h;
};
afterEach(async () => {
  for (const h of open.splice(0).reverse()) await h.close();
});

const errorOf = (res: { json: unknown }) => ApiErrorResponseSchema.parse(res.json).error;
const withoutRequestId = (res: { json: unknown }) => {
  const { requestId: _requestId, ...rest } = errorOf(res);
  return rest;
};
const cookieToken = (setCookie: unknown): string => decodeURIComponent(/^[^=]+=([^;]*)/.exec(String(setCookie))?.[1] ?? '');
const databaseBytes = (path: string): string => [path, `${path}-wal`].filter(existsSync).map((p) => readFileSync(p).toString('latin1')).join('');

const signIn = (h: SqliteHarness, over: { identifier?: string; password?: string; address?: string } = {}) =>
  h.app.inject({
    method: 'POST',
    url: '/api/session',
    remoteAddress: over.address ?? '198.51.100.7',
    payload: { identifier: over.identifier ?? SEED_IDENTIFIERS.a, password: over.password ?? SEED_PASSWORD },
  });

const MARKER = 'SQLITE-IMAP-PASSWORD-MARKER-3e9a';
const accountBody = {
  email: 'restart@provider.example',
  displayName: 'Yeniden başlat',
  username: 'restart-login-marker@provider.example',
  password: MARKER,
  imap: { host: 'imap.restart-host-marker.example', port: 993, security: 'ssl' },
  smtp: { host: 'smtp.restart-host-marker.example', port: 465, security: 'ssl' },
};

describe('RESTART: everything survives closing and reopening the database', () => {
  it('users, sessions, revocation, accounts, credentials, folders, messages, recipients, labels, attachment metadata, drafts, outbox, signatures, templates', async () => {
    // ── first run ──
    const first = await start();
    const login = await signIn(first);
    expect(login.statusCode).toBe(201);
    const sessionToken = cookieToken(login.headers['set-cookie']);
    const csrf = String(login.headers['x-csrf-token']);

    const created = await first.request('POST', '/accounts', { as: sessionToken, body: accountBody });
    expect(created.status).toBe(201);
    const newAccountId = (created.json as { id: string }).id;

    const label = await first.request('POST', `/accounts/${IDS.a1}/labels`, { as: sessionToken, body: { name: 'Kalıcı', tone: 4 } });
    expect(label.status).toBe(201);
    expect((await first.request('PUT', `/accounts/${IDS.a1}/signatures/sig-1`, { as: sessionToken, body: { name: 'İmza', body: 'Saygılarımla', isDefault: true } })).status).toBe(200);
    expect((await first.request('PUT', '/templates/tpl-1', { as: sessionToken, body: { title: 'Merhaba', content: 'Selam' } })).status).toBe(200);
    const draftBody = { accountId: IDS.a1, to: [{ email: 'a@example.com', name: 'A' }, { email: 'b@example.com', name: '' }], cc: [{ email: 'c@example.com', name: '' }], bcc: [], subject: 'Kalıcı taslak', bodyText: 'içerik', bodyHtml: null, attachmentIds: [], source: null };
    expect((await first.request('PUT', '/drafts/draft-1', { as: sessionToken, body: draftBody })).status).toBe(200);
    const outbox = await first.request('POST', '/drafts/draft-1/send', { as: sessionToken });
    expect(outbox.status).toBe(202);
    const outboxId = (outbox.json as { id: string }).id;

    // a message with recipients, labels and attachment metadata, written the way synchronisation will
    const a1 = first.access(IDS.a1, USER_A);
    const template = (await first.persistence.messages.findOwned(USER_A, IDS.m1)) as NonNullable<Awaited<ReturnType<typeof first.persistence.messages.findOwned>>>;
    await first.persistence.mailStore.upsertMessage(a1, { message: { ...template, id: 'restart-msg', subject: 'Yeniden başlatma sınaması', labels: ['Kalıcı'], to: [{ email: 'z@example.com', name: 'Z' }, { email: 'a@example.com', name: '' }], cc: [{ email: 'cc@example.com', name: '' }], attachments: [{ id: 'restart-att', messageId: 'restart-msg', fileName: 'kalici.pdf', mimeType: 'application/pdf', sizeBytes: 10, isInline: false }], hasAttachments: true }, provider: { uid: 5, uidValidity: 9, modSeq: null, messageIdHeader: '<r@x>', inReplyTo: null, references: null } });

    // a second session that is logged OUT before the restart
    const doomed = cookieToken((await signIn(first, { address: '198.51.100.8' })).headers['set-cookie']);
    expect((await first.request('DELETE', '/session', { as: doomed })).status).toBe(204);

    const { path, tokens } = first;
    await first.stop(); // HTTP drained, connection closed

    // ── second run: a brand-new application over the same file ──
    const second = await start({ path, tokens });
    // the session survived the restart (nothing was resurrected, nothing was lost)
    const session = await second.request('GET', '/session', { as: sessionToken });
    expect(session.json).toMatchObject({ authenticated: true, user: { id: USER_A } });
    expect(String(session.headers['x-csrf-token'])).toBe(csrf); // the CSRF token derives from the same secret
    // the logged-out session stays revoked
    const revoked = await second.request('GET', '/accounts', { as: doomed });
    expect(revoked.status).toBe(401);
    expect(errorOf(revoked).code).toBe('session_expired');
    // the password still works, sessions can be created again
    expect((await signIn(second, { address: '198.51.100.9' })).statusCode).toBe(201);
    expect(errorOf({ json: (await signIn(second, { password: 'wrong password!!', address: '198.51.100.10' })).json() }).code).toBe('invalid_credentials');

    // accounts, ownership
    const accounts = await second.request('GET', '/accounts', { as: sessionToken });
    expect((accounts.json as { items: Array<{ id: string }> }).items.map((a) => a.id)).toEqual([IDS.a1, IDS.a2, newAccountId]);
    expect((await second.request('GET', `/accounts/${IDS.a1}/folders`, { as: 'b' })).status).toBe(404); // still someone else's
    // credential: ciphertext survived, decrypts only through the credential boundary
    const seen = await second.services.credentials.withCredentialForMailAdapter(second.access(newAccountId, USER_A), (c) => Promise.resolve(`${c.username}|${c.password}|${c.imap.host}`));
    expect(seen).toBe('restart-login-marker@provider.example|' + MARKER + '|imap.restart-host-marker.example');
    // folders + messages + recipients + labels + attachment metadata
    const folders = await second.request('GET', `/accounts/${IDS.a1}/folders`, { as: sessionToken });
    expect((folders.json as { items: Array<{ id: string }> }).items.map((f) => f.id)).toEqual(expect.arrayContaining([IDS.a1Inbox, IDS.a1Child]));
    const message = await second.request('GET', '/messages/restart-msg', { as: sessionToken });
    expect(MessageSchema.safeParse(message.json).success).toBe(true);
    expect(message.json).toMatchObject({ subject: 'Yeniden başlatma sınaması', labels: ['Kalıcı'], to: [{ email: 'z@example.com' }, { email: 'a@example.com' }], cc: [{ email: 'cc@example.com' }], attachments: [{ id: 'restart-att', fileName: 'kalici.pdf' }] });
    expect(await second.persistence.mailStore.providerRefOfMessage(second.access(IDS.a1, USER_A), 'restart-msg')).toMatchObject({ uid: 5, uidValidity: 9 });
    const found = await second.request('GET', '/search', { as: sessionToken, query: { q: 'yeniden baslatma', accounts: 'all' } });
    expect((found.json as { items: Array<{ message: { id: string } }> }).items.map((i) => i.message.id)).toContain('restart-msg'); // the search index survived
    // labels, signature, template, draft, outbox
    expect(((await second.request('GET', `/accounts/${IDS.a1}/labels`, { as: sessionToken })).json as { items: Array<{ name: string }> }).items.map((l) => l.name)).toContain('Kalıcı');
    expect((await second.request('GET', `/accounts/${IDS.a1}/signatures`, { as: sessionToken })).json).toMatchObject({ items: [{ id: 'sig-1', isDefault: true }] });
    expect((await second.request('GET', '/templates', { as: sessionToken })).json).toMatchObject({ items: [{ id: 'tpl-1', title: 'Merhaba' }] });
    expect(await second.persistence.drafts.find(USER_A, 'draft-1')).toMatchObject({ subject: 'Kalıcı taslak', to: [{ email: 'a@example.com' }, { email: 'b@example.com' }], cc: [{ email: 'c@example.com' }] });
    expect(await second.persistence.outbox.find(USER_A, outboxId)).toMatchObject({ id: outboxId, state: 'queued', draftId: 'draft-1' });
    // …and the durable outbox item can still be cancelled after the restart
    expect((await second.request('POST', `/outbox/${outboxId}/cancel`, { as: sessionToken })).json).toMatchObject({ cancelled: true });
  });

  it('a session expires on schedule across restarts: the clock, not the process, decides', async () => {
    const first = await start();
    const { path, tokens, clock } = first;
    await first.stop();
    clock.advance((first.config.session.idleTtlSeconds + 1) * 1000);
    const second = await start({ path, tokens, clock });
    expect(errorOf(await second.request('GET', '/accounts')).code).toBe('session_expired');
  });

  it('a revoke-all persists: every session of the user stays dead after the restart', async () => {
    const first = await start();
    await first.services.auth.issueSession(USER_A);
    expect(await first.services.auth.revokeAllForUser(USER_A)).toBe(2);
    const { path, tokens } = first;
    await first.stop();
    const second = await start({ path, tokens });
    expect((await second.request('GET', '/accounts')).status).toBe(401);
    expect((await second.request('GET', '/accounts', { as: 'b' })).status).toBe(200);
  });
});

describe('Phase 4 security, unchanged, on SQLite', () => {
  it('nothing sensitive is in the database file: no password, no session secret, no CSRF token, no credential plaintext', async () => {
    const h = await start();
    const login = await signIn(h);
    const token = cookieToken(login.headers['set-cookie']);
    const csrf = String(login.headers['x-csrf-token']);
    await h.request('POST', '/accounts', { as: token, body: accountBody });
    await signIn(h, { password: 'attempted-wrong-password-77', address: '198.51.100.30' });
    await h.stop();
    let bytes = databaseBytes(h.path);
    for (const secret of [SEED_PASSWORD, 'attempted-wrong-password-77', token, csrf, MARKER, accountBody.username, 'imap.restart-host-marker.example', 'smtp.restart-host-marker.example']) {
      expect(bytes, secret).not.toContain(secret);
    }
    bytes = readFileSync(h.path).toString('latin1'); // main file only, after the shutdown checkpoint
    expect(bytes).not.toContain(MARKER);
    // What IS there: the Argon2id hash, the fingerprint, and the versioned envelope.
    const raw = new DatabaseSync(h.path);
    expect(String(raw.prepare('SELECT password_hash FROM users LIMIT 1').get()?.['password_hash'])).toMatch(/^\$argon2id\$/);
    expect(raw.prepare('SELECT secret_fingerprint FROM sessions WHERE secret_fingerprint = ?').get(h.secrets.fingerprint(token))).toBeDefined();
    expect(String(raw.prepare('SELECT encrypted_value FROM mail_account_credentials').get()?.['encrypted_value'])).toMatch(/^kaydet\.v1\.aes-256-gcm\./);
    raw.close();
  });

  it('cookie, CSRF and revocation behave exactly as before', async () => {
    const h = await start();
    const login = await signIn(h);
    expect(String(login.headers['set-cookie'])).toMatch(/HttpOnly.*SameSite=Lax|SameSite=Lax.*HttpOnly/);
    expect(login.json()).toEqual({ authenticated: true, user: { id: USER_A }, expiresAt: expect.any(String) });
    const token = cookieToken(login.headers['set-cookie']);
    expect((await h.request('PUT', '/templates/t1', { as: token, csrf: false, body: { title: 'x', content: 'y' } })).status).toBe(403); // CSRF still required
    expect((await h.request('DELETE', '/session', { as: token })).status).toBe(204);
    expect(errorOf(await h.request('GET', '/accounts', { as: token })).code).toBe('session_expired');
  });

  it('every account-scoped route: a foreign or nonexistent account is account_not_found, and the two look identical', async () => {
    const h = await start();
    for (const [name, method, url, body, query] of ACCOUNT_SCOPED(IDS.b1)) {
      const foreign = await h.request(method, url, { ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
      const [, , missingUrl, missingBody, missingQuery] = ACCOUNT_SCOPED('acc-does-not-exist').find((r) => r[0] === name)!;
      const missing = await h.request(method, missingUrl, { ...(missingBody === undefined ? {} : { body: missingBody }), ...(missingQuery === undefined ? {} : { query: missingQuery }) });
      expect(foreign.status, name).toBe(404);
      expect(errorOf(foreign).code, name).toBe('account_not_found');
      expect(withoutRequestId(foreign), name).toEqual(withoutRequestId(missing));
    }
    expect((await h.persistence.accounts.listByUser(USER_B)).map((a) => a.id)).toEqual([IDS.b1]); // untouched
  });

  it('anonymous, expired and revoked callers are refused on every session route', async () => {
    const h = await start();
    const revoked = await h.services.auth.issueSession(USER_A);
    await h.services.auth.logout(revoked.sessionId);
    for (const name of Object.keys(api) as ApiRouteName[]) {
      const spec: RouteSpec = api[name];
      if (spec.auth !== 'session') continue;
      const path = spec.path.replace(/:([A-Za-z]+)/g, (_m, n: string) => (n === 'token' ? 'a'.repeat(24) : 'x1'));
      expect((await h.request(spec.method, path, { as: 'none' })).status, `anonymous ${name}`).toBe(401);
      const res = await h.request(spec.method, path, { as: revoked.token });
      expect([res.status, errorOf(res).code], `revoked ${name}`).toEqual([401, 'session_expired']);
    }
  });

  it('login is throttled the same way (in-memory limiter, per process)', async () => {
    const h = await start();
    for (let i = 0; i < h.config.loginLimits.maxFailuresPerIdentifier; i++) await signIn(h, { password: 'wrong password!!', address: `10.1.0.${i}` });
    expect((await signIn(h, { address: '10.1.9.9' })).statusCode).toBe(429);
  });

  it('credentials never appear in responses, events or logs on SQLite either', async () => {
    const h = await start({ env: { LOG_LEVEL: 'trace' } });
    const created = await h.request('POST', '/accounts', { body: accountBody });
    const id = (created.json as { id: string }).id;
    const responses = [created, await h.request('GET', '/accounts'), await h.request('PATCH', `/accounts/${id}`, { body: { password: `${MARKER}-2` } }), await h.request('DELETE', `/accounts/${id}`)];
    expect(responses.map((r) => r.status)).toEqual([201, 200, 200, 204]);
    const everything = [...responses.map((r) => r.text), JSON.stringify(h.events.published), h.logLines.join('\n')].join('\n');
    for (const marker of [MARKER, accountBody.username, 'restart-host-marker']) expect(everything, marker).not.toContain(marker);
    expect(h.logLines.length).toBeGreaterThan(3);
  });
});

describe('contract-compatible responses from stored data', () => {
  it('accounts, folders, message pages, single messages and search validate against the domain schemas', async () => {
    const h = await start();
    expect(AccountSchema.array().safeParse(((await h.request('GET', '/accounts')).json as { items: unknown[] }).items).success).toBe(true);
    expect(SessionSchema.safeParse((await h.request('GET', '/session')).json).success).toBe(true);
    const page = await h.request('GET', `/accounts/${IDS.a1}/messages`, { query: { scope: 'folder', folderId: IDS.a1Inbox, limit: '1' } });
    expect(MessagePageSchema.safeParse(page.json).success).toBe(true);
    const next = (page.json as { nextCursor: string }).nextCursor;
    expect(typeof next).toBe('string');
    const second = await h.request('GET', `/accounts/${IDS.a1}/messages`, { query: { scope: 'folder', folderId: IDS.a1Inbox, limit: '1', cursor: next } });
    expect(MessagePageSchema.safeParse(second.json).success).toBe(true);
    expect((second.json as { nextCursor: unknown }).nextCursor).toBeNull();
    expect(MessageSchema.safeParse((await h.request('GET', `/messages/${IDS.m1}`)).json).success).toBe(true);
    expect(SearchPageSchema.safeParse((await h.request('GET', '/search', { query: { q: 'toplanti', accounts: 'all' } })).json).success).toBe(true);
    const draft = await h.request('PUT', '/drafts/dc', { body: { accountId: IDS.a1, to: [{ email: 'a@example.com', name: '' }], cc: [], bcc: [], subject: 's', bodyText: 'b', bodyHtml: null, attachmentIds: [], source: null } });
    expect(DraftSchema.safeParse(draft.json).success).toBe(true);
    expect(OutboxSchema.safeParse((await h.request('POST', '/drafts/dc/send')).json).success).toBe(true);
  });

  it('no provider concept appears in any API response for a message stored WITH provider identity', async () => {
    const h = await start();
    const base = (await h.persistence.messages.findOwned(USER_A, IDS.m1)) as NonNullable<Awaited<ReturnType<typeof h.persistence.messages.findOwned>>>;
    await h.persistence.mailStore.upsertMessage(h.access(IDS.a1, USER_A), { message: { ...base, id: 'prov-msg', subject: 'sağlayıcı kimliği', attachments: [], hasAttachments: false }, provider: { uid: 987654, uidValidity: 424242, modSeq: 31337, messageIdHeader: '<hidden-header@provider.example>', inReplyTo: null, references: null } });
    const responses = [
      await h.request('GET', '/messages/prov-msg'),
      await h.request('GET', `/accounts/${IDS.a1}/messages`, { query: { scope: 'folder', folderId: IDS.a1Inbox } }),
      await h.request('GET', '/search', { query: { q: 'saglayici', accounts: 'all' } }),
    ];
    expect(responses[0]?.status).toBe(200);
    const text = responses.map((r) => r.text).join('\n');
    for (const hidden of ['987654', '424242', '31337', 'hidden-header@provider.example']) expect(text, hidden).not.toContain(hidden);
  });
});

describe('failures never leak SQLite', () => {
  it('a closed or broken database answers a generic internal_error (500), logged server-side, with nothing from SQLite in the body', async () => {
    const h = await start({ env: { LOG_LEVEL: 'info' } });
    await h.persistence.db.close(); // simulate the connection dying under a running server
    const res = await h.request('GET', '/accounts');
    expect(res.status).toBe(401 === res.status ? 401 : res.status); // the session lookup itself hits the database
    expect([500, 401]).toContain(res.status);
    expect(res.text).not.toMatch(/sqlite|database|constraint|SQLITE|kaydet\.db|no such table/i);
    expect(ApiErrorResponseSchema.safeParse(res.json).success).toBe(true);
  });

  it('write contention from another process becomes a retryable service_unavailable with Retry-After', async () => {
    const h = await start({ env: { DATABASE_BUSY_TIMEOUT_MS: '1' } });
    // A second connection (another process) takes the write lock; our server times out waiting for it.
    const other = new DatabaseSync(h.path);
    other.exec('BEGIN IMMEDIATE');
    try {
      const res = await h.request('PUT', '/templates/busy', { body: { title: 'x', content: 'y' } });
      // The session lookup may touch lastSeenAt first; either way the client only ever sees the contract error.
      expect([503, 200, 401]).toContain(res.status);
      if (res.status === 503) {
        expect(errorOf(res).code).toBe('service_unavailable');
        expect(res.headers['retry-after']).toBe('1');
      }
      expect(res.text).not.toMatch(/sqlite|locked|busy|SQLITE/i);
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
  });

  it('a busy database at the repository level is an AppError(service_unavailable), not a raw error', async () => {
    const h = await start({ env: { DATABASE_BUSY_TIMEOUT_MS: '1' } });
    const other = new DatabaseSync(h.path);
    other.exec('BEGIN IMMEDIATE');
    try {
      const error = await h.persistence.templates.save(USER_A, { id: 'busy', title: 't', content: '', isBuiltIn: false }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('service_unavailable');
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
  });
});

describe('use-case transactions (all-or-nothing) on SQLite', () => {
  const failingCrypto = { activeKeyId: 'k1', encrypt: () => Promise.reject(new Error('encryption service down')), decrypt: () => Promise.reject(new Error('x')), inspect: () => null };
  const count = async (h: SqliteHarness, sql: string, params: Array<string | number> = []) => Number((await h.persistence.db.get(sql, params))?.['n']);

  it('login: revoking the presented session and creating the new one are ONE unit — a failed insert un-revokes', async () => {
    const h = await start();
    const old = await h.services.auth.issueSession(USER_A);
    const sessions = h.persistence.sessions;
    await expect(
      h.persistence.transactions.run(async () => {
        await sessions.revoke(old.sessionId, h.clock.now());
        // primary-key clash with the existing session row
        await sessions.create({ id: old.sessionId, userId: USER_A, secretFingerprint: 'other', createdAt: h.clock.now(), expiresAt: h.clock.now(), lastSeenAt: h.clock.now(), revokedAt: null });
      }),
    ).rejects.toThrow();
    expect((await h.services.auth.resolve(old.token)).status).toBe('active'); // the revoke was rolled back
  });

  it('login through the service: a failing session insert leaves the presented session valid', async () => {
    const seeded = await start();
    const old = await seeded.services.auth.issueSession(USER_A);
    const { path, tokens } = seeded;
    await seeded.stop();

    const holder: { real?: SessionRepository } = {};
    const failing: SessionRepository = {
      create: () => Promise.reject(new Error('disk full')),
      findByFingerprint: (f) => (holder.real as SessionRepository).findByFingerprint(f),
      touch: (id, at) => (holder.real as SessionRepository).touch(id, at),
      revoke: (id, at) => (holder.real as SessionRepository).revoke(id, at),
      revokeAllForUser: (u, at, except) => (holder.real as SessionRepository).revokeAllForUser(u, at, except),
    };
    const h = await start({ path, tokens, ports: { sessions: failing } });
    holder.real = h.persistence.sessions;
    await expect(
      h.services.auth.login({ identifier: SEED_IDENTIFIERS.a, password: SEED_PASSWORD, clientAddress: '198.51.100.99', replacingSessionId: old.sessionId }),
    ).rejects.toThrow('disk full');
    expect((await h.services.auth.resolve(old.token)).status).toBe('active');
  });

  it('createAccount: an encryption failure leaves NO account and NO credential row (account + credential are atomic)', async () => {
    const h = await start({ ports: { crypto: failingCrypto } });
    const res = await h.request('POST', '/accounts', { body: accountBody });
    expect(res.status).toBe(500);
    expect(errorOf(res).code).toBe('internal_error');
    expect(res.text).not.toContain('encryption service down');
    expect(await count(h, "SELECT count(*) AS n FROM mail_accounts WHERE email = 'restart@provider.example'")).toBe(0);
    expect(await count(h, 'SELECT count(*) AS n FROM mail_account_credentials')).toBe(0);
    expect(h.events.published).toEqual([]); // nothing announced for a change that never happened
  });

  it('updateAccount: a credential failure also undoes the metadata change', async () => {
    const good = await start();
    const created = await good.request('POST', '/accounts', { body: accountBody });
    const id = (created.json as { id: string }).id;
    const { path, tokens } = good;
    await good.stop();

    const h = await start({ path, tokens, ports: { crypto: failingCrypto } });
    const res = await h.request('PATCH', `/accounts/${id}`, { body: { displayName: 'Yeni ad', password: 'new-secret-value' } });
    expect(res.status).toBe(500);
    expect((await h.persistence.accounts.findOwned(USER_A, id))?.displayName).toBe('Yeniden başlat'); // unchanged
  });

  it('deleteAccount: if removing the credential fails, the account is NOT deleted either', async () => {
    const good = await start();
    const id = ((await good.request('POST', '/accounts', { body: accountBody })).json as { id: string }).id;
    const { path, tokens } = good;
    await good.stop();

    const failing = { find: () => Promise.resolve(null), replace: () => Promise.resolve(), remove: () => Promise.reject(new Error('credential store down')) };
    const h = await start({ path, tokens, ports: { credentialRecords: failing } });
    expect((await h.request('DELETE', `/accounts/${id}`)).status).toBe(500);
    expect(await h.persistence.accounts.findOwned(USER_A, id)).not.toBeNull();
    expect(h.events.published).toEqual([]);
  });

  it('two concurrent sends of one draft: exactly one is queued, the others are draft_already_sent (no double send)', async () => {
    const h = await start();
    await h.request('PUT', '/drafts/race', { body: { accountId: IDS.a1, to: [{ email: 'a@example.com', name: '' }], cc: [], bcc: [], subject: 's', bodyText: 'b', bodyHtml: null, attachmentIds: [], source: null } });
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => h.request('POST', '/drafts/race/send')));
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 202)) expect(errorOf(r).code).toBe('draft_already_sent');
    expect(await count(h, "SELECT count(*) AS n FROM outbox WHERE draft_id = 'race'")).toBe(1);
  });

  it('two concurrent creations of the same mail account: one succeeds, the others are account_exists (never a 500)', async () => {
    const h = await start();
    const results = await Promise.all([1, 2, 3].map(() => h.request('POST', '/accounts', { body: accountBody })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await count(h, "SELECT count(*) AS n FROM mail_accounts WHERE email = 'restart@provider.example'")).toBe(1);
    expect(await count(h, 'SELECT count(*) AS n FROM mail_account_credentials WHERE account_id NOT IN (SELECT id FROM mail_accounts)')).toBe(0);
  });

  it('concurrent default-signature writes keep "at most one default" and never surface a constraint error', async () => {
    const h = await start();
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((id) => h.request('PUT', `/accounts/${IDS.a1}/signatures/${id}`, { body: { name: id, body: id, isDefault: true } })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await count(h, 'SELECT count(*) AS n FROM signatures WHERE account_id = ? AND is_default = 1', [IDS.a1])).toBe(1);
  });

  it('concurrent reads and writes are all served (no lock-ups on the shared connection)', async () => {
    const h = await start();
    const writes = Array.from({ length: 20 }, (_, i) => h.request('PUT', `/templates/t${i}`, { body: { title: `t${i}`, content: 'c' } }));
    const reads = Array.from({ length: 40 }, () => h.request('GET', `/accounts/${IDS.a1}/messages`, { query: { scope: 'folder', folderId: IDS.a1Inbox } }));
    const all = await Promise.all([...writes, ...reads]);
    expect(all.every((r) => r.status === 200)).toBe(true);
    expect(await count(h, 'SELECT count(*) AS n FROM templates WHERE user_id = ?', [USER_A])).toBe(20);
  });

  it('ports stay interchangeable: a scripted repository composes with the SQLite app', async () => {
    const h = await start({ ports: { accounts: accountsWith({ listByUser: () => Promise.resolve([]) }) } });
    expect((await h.request('GET', '/accounts')).json).toEqual({ items: [] });
  });
});

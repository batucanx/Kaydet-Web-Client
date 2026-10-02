/**
 * The SQLite repositories through the real stack (migrations, transactions, use cases, security services).
 * Users, sessions, accounts, credentials, folders, labels, drafts, outbox, signatures and templates.
 */
import { readFileSync, existsSync } from 'node:fs';
import { AccountSchema, DraftSchema } from '@kaydet/domain';
import type { AccountCreateRequest, DraftInputDTO } from '@kaydet/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, ANONYMOUS_ACTOR, NO_SESSION } from '../../application/index.ts';
import type { RequestContext } from '../../application/index.ts';
import { IDS, USER_A, USER_B } from '../../testing/fixtures.ts';
import { SEED_IDENTIFIERS, SEED_PASSWORD, accountsWith } from '../../testing/harness.ts';
import { createSqliteTestApplication } from '../../testing/sqlite.ts';
import type { SqliteTestApplication } from '../../testing/sqlite.ts';

const apps: SqliteTestApplication[] = [];
const create = async (options: Parameters<typeof createSqliteTestApplication>[0] = {}) => {
  const app = await createSqliteTestApplication(options);
  apps.push(app);
  return app;
};
afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.cleanup(); // newest first: the owner of the directory goes last
});

const ctxFor = (userId: string): RequestContext => ({
  requestId: 'req',
  actor: userId === '' ? ANONYMOUS_ACTOR : { kind: 'user', userId },
  session: userId === '' ? NO_SESSION : { status: 'active', id: 's', expiresAt: new Date('2027-01-01T00:00:00.000Z'), csrfToken: 'c' },
  metadata: { method: 'TEST', route: '/test', clientAddress: '203.0.113.1' },
});
const A = ctxFor(USER_A);
const B = ctxFor(USER_B);

const failure = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected a failure');
};

/** Every byte the database wrote: the main file and its WAL. */
const databaseBytes = (path: string): string => [path, `${path}-wal`].filter(existsSync).map((p) => readFileSync(p).toString('latin1')).join('');

describe('users', () => {
  it('creates a user with a normalised, unique identifier and a real hash; the password is never stored', async () => {
    const app = await create();
    const { userId } = await app.services.users.createUser({ identifier: 'New.Person@Kaydet.test', password: 'a passphrase nobody would guess' });
    const stored = await app.persistence.users.findById(userId);
    expect(stored).toMatchObject({ id: userId, identifier: 'new.person@kaydet.test' });
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
    expect((await app.persistence.users.findByIdentifier('new.person@kaydet.test'))?.id).toBe(userId);
    expect(databaseBytes(app.path)).not.toContain('a passphrase nobody would guess');
  });

  it('the unique index rejects a second user with the same identifier (also when the check-then-insert would race)', async () => {
    const app = await create();
    const now = app.clock.now();
    const user = { id: 'u-x', identifier: 'dup@kaydet.test', passwordHash: 'h', createdAt: now, updatedAt: now };
    expect(await app.persistence.users.create(user)).toBe(true);
    expect(await app.persistence.users.create({ ...user, id: 'u-y' })).toBe(false);
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => app.persistence.users.create({ ...user, id: `u-race-${i}`, identifier: 'race@kaydet.test' })));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('updates a password hash and keeps the rest', async () => {
    const app = await create();
    const before = await app.persistence.users.findById(USER_A);
    app.clock.advance(60_000);
    await app.persistence.users.updatePasswordHash(USER_A, '$argon2id$replacement', app.clock.now());
    const after = await app.persistence.users.findById(USER_A);
    expect(after?.passwordHash).toBe('$argon2id$replacement');
    expect(after?.identifier).toBe(before?.identifier);
    expect(after?.updatedAt.getTime()).toBeGreaterThan(before?.updatedAt.getTime() ?? 0);
    expect(after?.createdAt).toEqual(before?.createdAt);
  });

  it('the seeded users can sign in against the database (real Argon2id verification)', async () => {
    const app = await create();
    const issued = await app.services.auth.login({ identifier: SEED_IDENTIFIERS.a, password: SEED_PASSWORD, clientAddress: '198.51.100.1', replacingSessionId: null });
    expect(issued.userId).toBe(USER_A);
  });
});

describe('sessions', () => {
  it('stores only the fingerprint; resolves, revokes and expires like the in-memory adapter', async () => {
    const app = await create();
    const issued = await app.services.auth.issueSession(USER_A);
    const stored = await app.persistence.sessions.snapshot();
    expect(JSON.stringify(stored)).not.toContain(issued.token);
    expect(databaseBytes(app.path)).not.toContain(issued.token);
    expect(stored.find((s) => s.id === issued.sessionId)?.secretFingerprint).toBe(app.secrets.fingerprint(issued.token));

    expect((await app.services.auth.resolve(issued.token)).status).toBe('active');
    await app.services.auth.logout(issued.sessionId);
    expect((await app.services.auth.resolve(issued.token)).status).toBe('expired');
    expect((await app.persistence.sessions.snapshot()).find((s) => s.id === issued.sessionId)?.revokedAt).not.toBeNull();

    const other = await app.services.auth.issueSession(USER_A);
    app.clock.advance((app.config.session.absoluteTtlSeconds + 1) * 1000);
    expect((await app.services.auth.resolve(other.token)).status).toBe('expired');
  });

  it('revokeAllForUser only touches that user and can spare one session', async () => {
    const app = await create();
    const second = await app.services.auth.issueSession(USER_A);
    expect(await app.services.auth.revokeAllForUser(USER_A, { exceptSessionId: second.sessionId })).toBe(1);
    expect((await app.services.auth.resolve(app.tokens.a)).status).toBe('expired');
    expect((await app.services.auth.resolve(second.token)).status).toBe('active');
    expect((await app.services.auth.resolve(app.tokens.b)).status).toBe('active');
  });

  it('deleting a user removes their sessions (cascade), and a user with accounts cannot be deleted (restrict)', async () => {
    const app = await create();
    const { db } = app.persistence;
    await expect(db.run('DELETE FROM users WHERE id = ?', [USER_A])).rejects.toThrow(); // A owns accounts
    const { userId } = await app.services.users.createUser({ identifier: 'temp@kaydet.test', password: 'a passphrase nobody would guess' });
    const session = await app.services.auth.issueSession(userId);
    await db.run('DELETE FROM users WHERE id = ?', [userId]);
    expect((await app.services.auth.resolve(session.token)).status).toBe('expired');
    expect((await db.get('SELECT count(*) AS n FROM sessions WHERE user_id = ?', [userId]))?.['n']).toBe(0);
  });
});

describe('mail accounts', () => {
  const request = (over: Partial<AccountCreateRequest> = {}): AccountCreateRequest => ({
    email: 'me@provider.example',
    displayName: 'Ben',
    username: 'imap-login-marker@provider.example',
    password: 'IMAP-PASSWORD-MARKER-5c1d',
    imap: { host: 'imap.private-host-marker.example', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.private-host-marker.example', port: 465, security: 'ssl' },
    ...over,
  });

  it('creates, lists, updates and deletes accounts of a user; the DTO is the safe contract shape', async () => {
    const app = await create();
    const created = await app.useCases.createAccount(A, request());
    expect(AccountSchema.safeParse(created).success).toBe(true);
    expect((await app.useCases.listAccounts(A)).items.map((a) => a.id)).toContain(created.id);

    const renamed = await app.useCases.updateAccount(A, created.id, { displayName: 'Yeni ad' });
    expect(renamed).toMatchObject({ id: created.id, displayName: 'Yeni ad', email: 'me@provider.example' });
    expect((await app.useCases.listAccounts(A)).items.find((a) => a.id === created.id)?.displayName).toBe('Yeni ad');

    await app.useCases.deleteAccount(A, created.id);
    expect((await app.useCases.listAccounts(A)).items.some((a) => a.id === created.id)).toBe(false);
  });

  it('one address once per user (case-insensitive) — enforced by the database — but two users may share an address', async () => {
    const app = await create();
    await app.useCases.createAccount(A, request());
    expect((await failure(app.useCases.createAccount(A, request({ email: 'ME@Provider.Example' })))).code).toBe('account_exists');
    // Even bypassing the use case's check, the unique index holds:
    const dup = { id: 'dup-account', email: 'Me@provider.example', displayName: '', supportsServerLabels: null, sync: { status: 'idle' as const, lastSyncAt: null } };
    expect((await failure(app.persistence.accounts.create(USER_A, dup))).code).toBe('account_exists');
    await expect(app.useCases.createAccount(B, request())).resolves.toBeDefined();
  });

  it('ownership: another user cannot see, update or delete an account, and the repository itself is user-scoped', async () => {
    const app = await create();
    expect(await app.persistence.accounts.findOwned(USER_B, IDS.a1)).toBeNull();
    expect((await app.persistence.accounts.listByUser(USER_B)).map((a) => a.id)).toEqual([IDS.b1]);
    expect((await failure(app.useCases.updateAccount(B, IDS.a1, { displayName: 'x' }))).code).toBe('account_not_found');
    expect((await failure(app.useCases.deleteAccount(B, IDS.a1))).code).toBe('account_not_found');
    // Defence in depth: even a forged AuthorizedAccount (right id, wrong user) cannot touch it.
    const forged = app.access(IDS.a1, USER_B);
    await app.persistence.accounts.remove(forged);
    expect(await app.persistence.accounts.findOwned(USER_A, IDS.a1)).not.toBeNull();
    await expect(app.persistence.accounts.update(forged, { displayName: 'hijacked' })).rejects.toBeInstanceOf(AppError);
    expect((await app.persistence.accounts.findOwned(USER_A, IDS.a1))?.displayName).toBe('');
  });

  it('deleting an account removes its whole local mirror (folders, messages, parts, labels, drafts, outbox, credential, search rows)', async () => {
    const app = await create();
    const created = await app.useCases.createAccount(A, request({ email: 'wipe@provider.example' }));
    const account = app.access(created.id, USER_A);
    await app.persistence.labels.save(account, { id: 'l-wipe', accountId: created.id, name: 'Sil', tone: 1 });
    await app.persistence.mailStore.upsertFolder(account, { id: 'f-wipe', name: 'Gelen Kutusu', role: 'inbox', sortOrder: 0, provider: { path: 'INBOX', delimiter: '.', uidValidity: 1, uidNext: 2, highestModSeq: null } });
    await app.persistence.mailStore.upsertMessage(account, {
      message: {
        id: 'm-wipe', accountId: created.id, folderId: 'f-wipe', threadId: 't', from: { email: 'x@y.z', name: 'X' }, to: [{ email: 'me@provider.example', name: '' }], subject: 'Silinecek', preview: 'p',
        date: '2026-09-01T10:00:00.000Z', seen: false, pinned: false, answered: false, forwarded: false, draft: false, hasAttachments: true, labels: ['Sil'], outbox: { state: 'none' },
        cc: [], bcc: [], body: { text: 'gövde metni', html: null }, attachments: [{ id: 'att-wipe', messageId: 'm-wipe', fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 1, isInline: false }],
      },
      provider: null,
    });
    await app.useCases.putDraft(A, 'd-wipe', { accountId: created.id, to: [], cc: [], bcc: [], subject: 'k', bodyText: '', bodyHtml: null, attachmentIds: [], source: null });

    await app.useCases.deleteAccount(A, created.id);

    const { db } = app.persistence;
    for (const [table, column] of [['folders', 'account_id'], ['messages', 'account_id'], ['labels', 'account_id'], ['drafts', 'account_id']] as const) {
      expect((await db.get(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`, [created.id]))?.['n'], table).toBe(0);
    }
    for (const table of ['message_recipients', 'message_bodies', 'message_labels']) {
      expect((await db.get(`SELECT count(*) AS n FROM ${table} WHERE message_id = 'm-wipe'`))?.['n'], table).toBe(0);
    }
    expect((await db.get("SELECT count(*) AS n FROM attachments WHERE id = 'att-wipe'"))?.['n']).toBe(0);
    expect((await db.get('SELECT count(*) AS n FROM mail_account_credentials WHERE account_id = ?', [created.id]))?.['n']).toBe(0);
    expect((await db.get("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'gövde OR govde OR silinecek'"))?.['n']).toBe(0);
    // The other accounts are untouched.
    expect((await db.get('SELECT count(*) AS n FROM messages WHERE account_id = ?', [IDS.a1]))?.['n']).toBeGreaterThan(0);
  });
});

describe('encrypted credentials', () => {
  const MARKERS = ['IMAP-PASSWORD-MARKER-5c1d', 'imap-login-marker@provider.example', 'imap.private-host-marker.example'];
  const body: AccountCreateRequest = {
    email: 'cred@provider.example',
    displayName: '',
    username: MARKERS[1] as string,
    password: MARKERS[0] as string,
    imap: { host: MARKERS[2] as string, port: 993, security: 'ssl' },
    smtp: { host: 'smtp.private-host-marker.example', port: 465, security: 'ssl' },
  };

  it('the database holds the Phase 4 envelope and never any plaintext — not in the file, not in the WAL', async () => {
    const app = await create();
    const created = await app.useCases.createAccount(A, body);
    const row = await app.persistence.db.get('SELECT encrypted_value, key_id FROM mail_account_credentials WHERE account_id = ?', [created.id]);
    expect(String(row?.['encrypted_value'])).toMatch(/^kaydet\.v1\.aes-256-gcm\.k1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/);
    expect(row?.['key_id']).toBe('k1');
    const bytes = databaseBytes(app.path);
    for (const marker of [...MARKERS, 'smtp.private-host-marker.example']) expect(bytes, marker).not.toContain(marker);
    await app.persistence.close();
    for (const marker of MARKERS) expect(readFileSync(app.path).toString('latin1'), marker).not.toContain(marker); // after checkpoint too
  });

  it('decrypts only through the credential boundary, and the ciphertext survives a restart', async () => {
    const first = await create();
    const created = await first.useCases.createAccount(A, body);
    const { path, tokens } = first;
    await first.persistence.close();

    const second = await create({ path, tokens });
    const account = second.access(created.id, USER_A);
    const seen = await second.services.credentials.withCredentialForMailAdapter(account, (c) => Promise.resolve(`${c.username}|${c.password}|${c.imap.host}`));
    expect(seen).toBe(`${MARKERS[1]}|${MARKERS[0]}|${MARKERS[2]}`);
    expect(await second.services.credentials.keyIdOf(account)).toBe('k1');
  });

  it('a credential update replaces the envelope in place (created_at kept, key id and updated_at refreshed)', async () => {
    const app = await create();
    const created = await app.useCases.createAccount(A, body);
    const before = await app.persistence.db.get('SELECT encrypted_value, created_at, updated_at FROM mail_account_credentials WHERE account_id = ?', [created.id]);
    app.clock.advance(5000);
    await app.useCases.updateAccount(A, created.id, { password: 'ANOTHER-PASSWORD-MARKER-77' });
    const after = await app.persistence.db.get('SELECT encrypted_value, created_at, updated_at FROM mail_account_credentials WHERE account_id = ?', [created.id]);
    expect(after?.['encrypted_value']).not.toBe(before?.['encrypted_value']);
    expect(after?.['created_at']).toBe(before?.['created_at']);
    expect(String(after?.['updated_at']) > String(before?.['updated_at'])).toBe(true);
    expect(databaseBytes(app.path)).not.toContain('ANOTHER-PASSWORD-MARKER-77');
  });

  it('the credential repository never decrypts: it returns the opaque envelope and nothing else', async () => {
    const app = await create();
    const created = await app.useCases.createAccount(A, body);
    const record = await app.persistence.credentialRecords.find(created.id);
    expect(Object.keys(record ?? {}).sort()).toEqual(['ciphertext', 'keyId', 'updatedAt']);
    expect(record?.ciphertext).not.toContain(MARKERS[0] as string);
  });
});

describe('folders', () => {
  it('builds the tree from provider paths (system roles are roots, custom folders keep their parent), with counters', async () => {
    const app = await create();
    const folders = await app.persistence.folders.listByAccount(app.access(IDS.a1, USER_A));
    const byId = new Map(folders.map((f) => [f.id, f]));
    expect(byId.get(IDS.a1Inbox)).toMatchObject({ role: 'inbox', parentId: null, depth: 0, unreadCount: 1, totalCount: 2 });
    expect(byId.get(IDS.a1Parent)).toMatchObject({ role: 'custom', parentId: null, depth: 0, hasChildren: true });
    expect(byId.get(IDS.a1Child)).toMatchObject({ parentId: IDS.a1Parent, depth: 1, hasChildren: false });
    // depth-first display order: the parent is immediately followed by its child
    const order = folders.map((f) => f.id);
    expect(order.indexOf(IDS.a1Child)).toBe(order.indexOf(IDS.a1Parent) + 1);
    expect(folders.every((f) => f.accountId === IDS.a1)).toBe(true);
  });

  it('isolates accounts: another account\'s folders are invisible, even by id', async () => {
    const app = await create();
    const a1 = app.access(IDS.a1, USER_A);
    expect(await app.persistence.folders.find(a1, IDS.a2Inbox)).toBeNull();
    expect(await app.persistence.folders.find(a1, IDS.b1Inbox)).toBeNull();
    expect((await app.persistence.folders.listByAccount(app.access(IDS.b1, USER_B))).map((f) => f.id)).toEqual([IDS.b1Inbox]);
  });

  it('the same server path exists once per account (unique), and a folder id cannot be taken over by another account', async () => {
    const app = await create();
    const a1 = app.access(IDS.a1, USER_A);
    const provider = { path: 'INBOX', delimiter: '.', uidValidity: null, uidNext: null, highestModSeq: null };
    await expect(app.persistence.mailStore.upsertFolder(a1, { id: 'other-id', name: 'Kopya', role: 'inbox', sortOrder: 0, provider })).rejects.toThrow(); // (account, path) is unique
    await expect(app.persistence.mailStore.upsertFolder(app.access(IDS.b1, USER_B), { id: IDS.a1Inbox, name: 'Ele geçir', role: 'inbox', sortOrder: 0, provider: { ...provider, path: 'X' } })).rejects.toThrow(/another account/);
    expect((await app.persistence.folders.find(a1, IDS.a1Inbox))?.name).toBe('Gelen Kutusu');
  });

  it('a favourite is a local preference: a sync upsert without it never resets it', async () => {
    const app = await create();
    const a1 = app.access(IDS.a1, USER_A);
    const provider = { path: 'Projeler', delimiter: '.', uidValidity: 7, uidNext: 8, highestModSeq: null };
    await app.persistence.mailStore.upsertFolder(a1, { id: IDS.a1Custom, name: 'Projeler', role: 'custom', sortOrder: 100, provider, isFavorite: true });
    await app.persistence.mailStore.upsertFolder(a1, { id: IDS.a1Custom, name: 'Projeler (yeni ad)', role: 'custom', sortOrder: 100, provider: { ...provider, uidNext: 99 } });
    expect(await app.persistence.folders.find(a1, IDS.a1Custom)).toMatchObject({ name: 'Projeler (yeni ad)', isFavorite: true });
    expect(await app.persistence.mailStore.providerRefOfFolder(a1, IDS.a1Custom)).toMatchObject({ uidValidity: 7, uidNext: 99 });
  });

  it('a folder that still has messages cannot vanish from under them (RESTRICT); removeFolder removes the messages explicitly', async () => {
    const app = await create();
    await expect(app.persistence.db.run('DELETE FROM folders WHERE id = ?', [IDS.a1Inbox])).rejects.toThrow();
    const a1 = app.access(IDS.a1, USER_A);
    await app.persistence.mailStore.removeFolder(a1, IDS.a1Inbox);
    expect(await app.persistence.folders.find(a1, IDS.a1Inbox)).toBeNull();
    expect(await app.persistence.messages.findOwned(USER_A, IDS.m1)).toBeNull();
    expect((await app.persistence.db.get("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'toplanti*'"))?.['n']).toBe(0);
  });
});

describe('labels', () => {
  it('are unique per account by their folded name and scoped to the account', async () => {
    const app = await create();
    const a1 = app.access(IDS.a1, USER_A);
    const made = await app.useCases.createLabel(A, IDS.a1, { name: 'Kişisel', tone: 3 });
    expect((await failure(app.useCases.createLabel(A, IDS.a1, { name: 'kisisel', tone: 1 }))).code).toBe('label_exists');
    await expect(app.useCases.createLabel(A, IDS.a2, { name: 'Kişisel', tone: 1 })).resolves.toBeDefined();
    expect((await app.persistence.labels.list(a1)).map((l) => l.name)).toEqual(['Kişisel']);
    expect(await app.persistence.labels.find(app.access(IDS.a2, USER_A), made.id)).toBeNull(); // wrong account
  });

  it('deleting a label removes its message associations, and the message is unharmed', async () => {
    const app = await create();
    const a1 = app.access(IDS.a1, USER_A);
    const label = await app.useCases.createLabel(A, IDS.a1, { name: 'İş', tone: 2 });
    const message = await app.persistence.messages.findOwned(USER_A, IDS.m1);
    await app.persistence.mailStore.upsertMessage(a1, { message: { ...(message as NonNullable<typeof message>), labels: ['İş'] }, provider: null });
    expect((await app.persistence.messages.findOwned(USER_A, IDS.m1))?.labels).toEqual(['İş']);
    await app.useCases.deleteLabel(A, IDS.a1, label.id);
    expect((await app.persistence.messages.findOwned(USER_A, IDS.m1))?.labels).toEqual([]);
    expect((await app.persistence.db.get('SELECT count(*) AS n FROM message_labels'))?.['n']).toBe(0);
  });

  it('a message cannot reference a label that does not exist', async () => {
    const app = await create();
    const message = (await app.persistence.messages.findOwned(USER_A, IDS.m1)) as NonNullable<Awaited<ReturnType<typeof app.persistence.messages.findOwned>>>;
    await expect(app.persistence.mailStore.upsertMessage(app.access(IDS.a1, USER_A), { message: { ...message, labels: ['yok'] }, provider: null })).rejects.toThrow();
    expect((await app.persistence.messages.findOwned(USER_A, IDS.m1))?.labels).toEqual([]); // the failed upsert changed nothing
  });
});

describe('signatures and templates', () => {
  it('at most one default signature per account (the database enforces it), and the use case keeps it consistent', async () => {
    const app = await create();
    await app.useCases.putSignature(A, IDS.a1, 's1', { name: 'Bir', body: '1', isDefault: true });
    await app.useCases.putSignature(A, IDS.a1, 's2', { name: 'İki', body: '2', isDefault: true });
    expect((await app.useCases.listSignatures(A, IDS.a1)).items.filter((s) => s.isDefault).map((s) => s.id)).toEqual(['s2']);
    await expect(app.persistence.db.run("UPDATE signatures SET is_default = 1 WHERE account_id = ? AND id = 's1'", [IDS.a1])).rejects.toThrow(); // second default: rejected
    expect((await failure(app.useCases.deleteSignature(A, IDS.a1, 'ghost'))).code).toBe('signature_not_found');
    // ids are per account
    await app.useCases.putSignature(A, IDS.a2, 's1', { name: 'Başka hesap', body: '', isDefault: true });
    expect((await app.useCases.listSignatures(A, IDS.a1)).items).toHaveLength(2);
  });

  it('templates belong to a user, keep their list position when edited, and survive as data', async () => {
    const app = await create();
    await app.useCases.putTemplate(A, 't1', { title: 'Bir', content: 'a' });
    await app.useCases.putTemplate(A, 't2', { title: 'İki', content: 'b' });
    await app.useCases.putTemplate(A, 't1', { title: 'Bir (düzenlendi)', content: 'a2' });
    expect((await app.useCases.listTemplates(A)).items.map((t) => t.id)).toEqual(['t1', 't2']); // t1 kept its place
    expect((await app.useCases.listTemplates(B)).items).toEqual([]);
    await app.useCases.putTemplate(B, 't1', { title: 'B\'nin şablonu', content: '' }); // same id, other user
    expect((await app.useCases.listTemplates(A)).items.find((t) => t.id === 't1')?.title).toBe('Bir (düzenlendi)');
    expect((await failure(app.useCases.deleteTemplate(B, 't2'))).code).toBe('template_not_found');
  });
});

describe('drafts', () => {
  const input = (over: Partial<DraftInputDTO> = {}): DraftInputDTO => ({
    accountId: IDS.a1,
    to: [{ email: 'one@example.com', name: 'Bir' }, { email: 'two@example.com', name: '' }, { email: 'three@example.com', name: 'Üç' }],
    cc: [{ email: 'cc@example.com', name: '' }],
    bcc: [{ email: 'bcc@example.com', name: '' }],
    subject: 'Konu',
    bodyText: 'Merhaba',
    bodyHtml: '<p>Merhaba</p>',
    attachmentIds: [],
    source: null,
    ...over,
  });

  it('creates, updates and reads back a draft with recipients in their original order', async () => {
    const app = await create();
    const saved = await app.useCases.putDraft(A, 'd1', input());
    expect(DraftSchema.safeParse(saved).success).toBe(true);
    const stored = await app.persistence.drafts.find(USER_A, 'd1');
    expect(stored).toEqual(saved);
    expect(stored?.to.map((a) => a.email)).toEqual(['one@example.com', 'two@example.com', 'three@example.com']);

    app.clock.advance(1000);
    await app.useCases.putDraft(A, 'd1', input({ subject: 'Yeni konu', to: [{ email: 'only@example.com', name: '' }], bcc: [] }));
    const updated = await app.persistence.drafts.find(USER_A, 'd1');
    expect(updated).toMatchObject({ subject: 'Yeni konu', bcc: [] });
    expect(updated?.to).toHaveLength(1);
    expect((await app.persistence.db.get('SELECT count(*) AS n FROM draft_recipients'))?.['n']).toBe(2); // 1 to + 1 cc + 0 bcc: no leftovers of the first version
  });

  it('is per user: the same client-generated id belongs to two users independently', async () => {
    const app = await create();
    await app.useCases.putDraft(A, 'shared', input({ subject: 'A nın' }));
    await app.useCases.putDraft(B, 'shared', input({ accountId: IDS.b1, subject: 'B nin' }));
    expect((await app.persistence.drafts.find(USER_A, 'shared'))?.subject).toBe('A nın');
    expect((await app.persistence.drafts.find(USER_B, 'shared'))?.subject).toBe('B nin');
    await app.useCases.deleteDraft(B, 'shared');
    expect(await app.persistence.drafts.find(USER_A, 'shared')).not.toBeNull();
  });

  it('keeps attachment metadata with the draft (owned by the draft, not by a message) and removes it with the draft', async () => {
    const app = await create();
    await app.useCases.putDraft(A, 'd1', input());
    const draft = (await app.persistence.drafts.find(USER_A, 'd1')) as NonNullable<Awaited<ReturnType<typeof app.persistence.drafts.find>>>;
    await app.persistence.drafts.save(USER_A, { ...draft, attachments: [{ id: 'att-d1', messageId: 'd1', fileName: 'ek.pdf', mimeType: 'application/pdf', sizeBytes: 12, isInline: false }] });
    expect((await app.persistence.drafts.find(USER_A, 'd1'))?.attachments).toEqual([{ id: 'att-d1', messageId: 'd1', fileName: 'ek.pdf', mimeType: 'application/pdf', sizeBytes: 12, isInline: false }]);
    expect((await app.useCases.putDraft(A, 'd1', input({ attachmentIds: ['att-d1'] }))).attachments).toHaveLength(1);
    await app.useCases.putDraft(A, 'd1', input({ attachmentIds: [] }));
    expect((await app.persistence.db.get("SELECT count(*) AS n FROM attachments WHERE id = 'att-d1'"))?.['n']).toBe(0); // dropped from the draft = removed
  });

  it('deleting a draft never deletes the Drafts-folder message it points to (SET NULL), and removes its recipients', async () => {
    const app = await create();
    const saved = await app.useCases.putDraft(A, 'd-linked', input());
    await app.persistence.drafts.save(USER_A, { ...saved, messageId: IDS.mDraft });
    expect((await app.persistence.drafts.find(USER_A, 'd-linked'))?.messageId).toBe(IDS.mDraft);
    await app.useCases.deleteDraft(A, 'd-linked');
    expect(await app.persistence.drafts.find(USER_A, 'd-linked')).toBeNull();
    expect(await app.persistence.messages.findOwned(USER_A, IDS.mDraft)).not.toBeNull(); // the unrelated message is untouched
    expect((await app.persistence.db.get("SELECT count(*) AS n FROM draft_recipients WHERE draft_id = 'd-linked'"))?.['n']).toBe(0);
  });

  it('draftId ≠ messageId ≠ outboxId: a draft exists without an outbox row, and deleting the message leaves the draft', async () => {
    const app = await create();
    const saved = await app.useCases.putDraft(A, 'd2', input());
    await app.persistence.drafts.save(USER_A, { ...saved, messageId: IDS.mDraft });
    await app.persistence.mailStore.removeMessage(app.access(IDS.a1, USER_A), IDS.mDraft);
    const after = await app.persistence.drafts.find(USER_A, 'd2');
    expect(after).not.toBeNull();
    expect(after?.messageId).toBeNull();
    expect(await app.persistence.outbox.findByDraft(USER_A, 'd2')).toBeNull();
  });

  it('survives a restart', async () => {
    const first = await create();
    await first.useCases.putDraft(A, 'd-restart', input());
    const { path, tokens } = first;
    await first.persistence.close();
    const second = await create({ path, tokens });
    expect((await second.persistence.drafts.find(USER_A, 'd-restart'))?.subject).toBe('Konu');
  });
});

describe('outbox', () => {
  const draft = { accountId: IDS.a1, to: [{ email: 'friend@example.com', name: '' }], cc: [], bcc: [], subject: 'Gönder', bodyText: 'x', bodyHtml: null, attachmentIds: [], source: null };

  it('queues a send with its own id, and the row survives a restart', async () => {
    const first = await create();
    await first.useCases.putDraft(A, 'd1', draft);
    const queued = await first.useCases.sendDraft(A, 'd1');
    expect(queued).toMatchObject({ draftId: 'd1', accountId: IDS.a1, messageId: null, state: 'queued', error: null });
    expect(queued.id).not.toBe('d1');
    const { path, tokens } = first;
    await first.persistence.close();
    const second = await create({ path, tokens });
    expect(await second.persistence.outbox.find(USER_A, queued.id)).toEqual(queued);
    expect(await second.persistence.outbox.findByDraft(USER_A, 'd1')).toEqual(queued);
  });

  it('stores state changes and the resulting message; only the four real states are allowed', async () => {
    const app = await create();
    await app.useCases.putDraft(A, 'd1', draft);
    const queued = await app.useCases.sendDraft(A, 'd1');
    await app.persistence.outbox.save(USER_A, { ...queued, state: 'sending', cancellableUntil: null });
    expect((await app.persistence.outbox.find(USER_A, queued.id))?.state).toBe('sending');
    await app.persistence.outbox.save(USER_A, { ...queued, state: 'failed', cancellableUntil: null, error: 'Alıcı reddedildi.' });
    expect(await app.persistence.outbox.find(USER_A, queued.id)).toMatchObject({ state: 'failed', error: 'Alıcı reddedildi.' });
    await app.persistence.outbox.save(USER_A, { ...queued, state: 'sent', cancellableUntil: null, error: null, messageId: IDS.m1 });
    expect(await app.persistence.outbox.find(USER_A, queued.id)).toMatchObject({ state: 'sent', messageId: IDS.m1 });
    await expect(app.persistence.outbox.save(USER_A, { ...queued, state: 'none' })).rejects.toThrow();
    await expect(app.persistence.db.run("UPDATE outbox SET state = 'exploded' WHERE id = ?", [queued.id])).rejects.toThrow(); // CHECK
  });

  it('keeps retry metadata (attempt count, next attempt) apart from the contract DTO', async () => {
    const app = await create();
    await app.useCases.putDraft(A, 'd1', draft);
    const queued = await app.useCases.sendDraft(A, 'd1');
    expect(await app.persistence.outbox.retryState(USER_A, queued.id)).toEqual({ attemptCount: 0, nextAttemptAt: null });
    const next = new Date('2026-09-30T12:05:00.000Z');
    await app.persistence.outbox.setRetryState(USER_A, queued.id, { attemptCount: 2, nextAttemptAt: next });
    expect(await app.persistence.outbox.retryState(USER_A, queued.id)).toEqual({ attemptCount: 2, nextAttemptAt: next });
    expect(Object.keys((await app.persistence.outbox.find(USER_A, queued.id)) ?? {}).sort()).toEqual(['accountId', 'cancellableUntil', 'draftId', 'error', 'id', 'messageId', 'state']);
    expect(await app.persistence.outbox.retryState(USER_B, queued.id)).toBeNull();
  });

  it('is per user and cancellable: another user cannot see or cancel it; cancelling removes the row', async () => {
    const app = await create();
    await app.useCases.putDraft(A, 'd1', draft);
    const queued = await app.useCases.sendDraft(A, 'd1');
    expect(await app.persistence.outbox.find(USER_B, queued.id)).toBeNull();
    expect((await failure(app.useCases.cancelOutbox(B, queued.id))).code).toBe('outbox_item_not_found');
    expect((await app.useCases.cancelOutbox(A, queued.id)).cancelled).toBe(true);
    expect(await app.persistence.outbox.find(USER_A, queued.id)).toBeNull();
  });

  it('deleting the draft removes its failed outbox rows with it (the send has no meaning without it)', async () => {
    const app = await create();
    await app.useCases.putDraft(A, 'd1', draft);
    const queued = await app.useCases.sendDraft(A, 'd1');
    await app.persistence.outbox.save(USER_A, { ...queued, state: 'failed', cancellableUntil: null, error: 'İleti gönderilemedi.' });
    await app.persistence.drafts.remove(USER_A, 'd1');
    expect(await app.persistence.outbox.find(USER_A, queued.id)).toBeNull();
  });
});

describe('accounts referenced elsewhere', () => {
  it('a draft for an account that does not exist is refused by the database', async () => {
    const app = await create();
    const saved = await app.persistence.drafts.save(USER_A, {
      id: 'd-x', accountId: 'no-such-account', to: [], cc: [], bcc: [], subject: '', bodyText: '', bodyHtml: null, attachments: [], source: null, messageId: null, updatedAt: app.clock.now().toISOString(),
    }).catch((e: unknown) => e);
    expect(saved).toBeInstanceOf(Error);
    expect(await app.persistence.drafts.find(USER_A, 'd-x')).toBeNull(); // rolled back
  });

  it('the repositories are usable as plain ports (memory-style listing via accountsWith is unaffected)', () => {
    expect(accountsWith({})).toBeDefined();
  });
});

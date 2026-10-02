/**
 * Mail-account credentials: encrypted at rest, write-only for use cases, readable only through the resolver that mail
 * adapters use, and never present in DTOs, events, errors or the stored envelope.
 */
import { AccountSchema } from '@kaydet/domain';
import { describe, expect, it } from 'vitest';
import type { AccountCreateRequest } from '@kaydet/domain';
import { AppError, ANONYMOUS_ACTOR, NO_SESSION } from './index.ts';
import type { RequestContext } from './index.ts';
import { createAccountAccess } from './services/account-access.ts';
import { createCredentialVault } from './services/credential-vault.ts';
import { AesGcmCrypto } from '../infrastructure/crypto/aes-gcm-crypto.ts';
import { ConfiguredKeyProvider } from '../infrastructure/crypto/key-provider.ts';
import { IDS, USER_A, USER_B } from '../testing/fixtures.ts';
import { createTestApplication } from '../testing/harness.ts';

const MARKER = 'IMAP-PASSWORD-MARKER-7f3a9c';
const USER_MARKER = 'imap-login-marker@provider.example';
const HOST_MARKER = 'imap.private-host-marker.example';

const ctxFor = (userId: string): RequestContext => ({
  requestId: 'req',
  actor: userId === '' ? ANONYMOUS_ACTOR : { kind: 'user', userId },
  session: userId === '' ? NO_SESSION : { status: 'active', id: 's', expiresAt: new Date('2027-01-01T00:00:00.000Z'), csrfToken: 'c' },
  metadata: { method: 'TEST', route: '/test', clientAddress: '203.0.113.1' },
});

const request = (over: Partial<AccountCreateRequest> = {}): AccountCreateRequest => ({
  email: 'me@provider.example',
  displayName: 'Ben',
  username: USER_MARKER,
  password: MARKER,
  imap: { host: HOST_MARKER, port: 993, security: 'ssl' },
  smtp: { host: 'smtp.private-host-marker.example', port: 465, security: 'ssl' },
  ...over,
});

const key = (byte: number) => new Uint8Array(32).fill(byte);
const provider = (active: string, ...keys: Array<[string, number]>) =>
  new ConfiguredKeyProvider({ activeKeyId: active, keys: new Map(keys.map(([id, byte]) => [id, key(byte)])) });

const failure = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected a failure');
};

describe('creating and updating mail accounts', () => {
  it('stores the credential ENCRYPTED and answers with the safe account DTO only', async () => {
    const app = await createTestApplication();
    const created = await app.useCases.createAccount(ctxFor(USER_A), request());

    expect(AccountSchema.safeParse(created).success).toBe(true); // strict: no extra keys
    expect(created).toMatchObject({ email: 'me@provider.example', displayName: 'Ben', sync: { status: 'idle', lastSyncAt: null } });
    const stored = [...app.memory.credentialRecords.snapshot().values()];
    expect(stored).toHaveLength(1);
    for (const marker of [MARKER, USER_MARKER, HOST_MARKER]) {
      expect(stored[0]?.ciphertext).not.toContain(marker);
      expect(JSON.stringify(created)).not.toContain(marker);
    }
    expect(app.composition.services.credentials).toBeDefined();
    expect((await app.useCases.listAccounts(ctxFor(USER_A))).items.some((a) => a.id === created.id)).toBe(true);
    expect(JSON.stringify(await app.useCases.listAccounts(ctxFor(USER_A)))).not.toContain(MARKER);
  });

  it('never publishes credentials in events', async () => {
    const app = await createTestApplication();
    const created = await app.useCases.createAccount(ctxFor(USER_A), request());
    await app.useCases.updateAccount(ctxFor(USER_A), created.id, { password: `${MARKER}-2`, displayName: 'Yeni' });
    expect(app.events.published.length).toBeGreaterThan(0);
    const published = JSON.stringify(app.events.published);
    for (const marker of [MARKER, USER_MARKER, HOST_MARKER]) expect(published).not.toContain(marker);
  });

  it('refuses a duplicate e-mail per user (case-insensitive) but allows the same address for another user', async () => {
    const app = await createTestApplication();
    await app.useCases.createAccount(ctxFor(USER_A), request());
    expect((await failure(app.useCases.createAccount(ctxFor(USER_A), request({ email: 'ME@Provider.Example' })))).code).toBe('account_exists');
    await expect(app.useCases.createAccount(ctxFor(USER_B), request())).resolves.toBeDefined();
  });

  it('requires a signed-in user', async () => {
    const app = await createTestApplication();
    expect((await failure(app.useCases.createAccount(ctxFor(''), request()))).code).toBe('not_authenticated');
  });

  it('a credential update replaces the ciphertext, returns nothing secret, and keeps untouched fields', async () => {
    const app = await createTestApplication();
    const created = await app.useCases.createAccount(ctxFor(USER_A), request());
    const before = app.memory.credentialRecords.snapshot().get(created.id)?.ciphertext;

    const updated = await app.useCases.updateAccount(ctxFor(USER_A), created.id, { password: 'brand-new-secret-marker-2' });
    const after = app.memory.credentialRecords.snapshot().get(created.id)?.ciphertext;
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(after).not.toContain('brand-new-secret-marker-2');
    expect(JSON.stringify(updated)).not.toMatch(/marker|password/i);
    expect(AccountSchema.safeParse(updated).success).toBe(true);

    // Only the password changed: username and endpoints are still the stored ones.
    const access = createAccountAccess(app.memory.accounts);
    const account = await access.authorize(ctxFor(USER_A), created.id);
    const seen = await app.services.credentials.withCredentialForMailAdapter(account, (c) => Promise.resolve(c));
    expect(seen).toEqual({ username: USER_MARKER, password: 'brand-new-secret-marker-2', imap: request().imap, smtp: request().smtp });
  });

  it('a display-name-only update does not touch the credential record', async () => {
    const app = await createTestApplication();
    const created = await app.useCases.createAccount(ctxFor(USER_A), request());
    const before = app.memory.credentialRecords.snapshot().get(created.id);
    expect((await app.useCases.updateAccount(ctxFor(USER_A), created.id, { displayName: 'Başka' })).displayName).toBe('Başka');
    expect(app.memory.credentialRecords.snapshot().get(created.id)).toBe(before);
  });

  it('another user cannot update or delete an account or its credential, and cannot tell it exists', async () => {
    const app = await createTestApplication();
    const created = await app.useCases.createAccount(ctxFor(USER_A), request());
    const before = app.memory.credentialRecords.snapshot().get(created.id);
    expect((await failure(app.useCases.updateAccount(ctxFor(USER_B), created.id, { password: 'attacker-chosen-secret' }))).code).toBe('account_not_found');
    expect((await failure(app.useCases.deleteAccount(ctxFor(USER_B), created.id))).code).toBe('account_not_found');
    expect(app.memory.credentialRecords.snapshot().get(created.id)).toBe(before);
  });

  it('deleting the account deletes its encrypted credential', async () => {
    const app = await createTestApplication();
    const created = await app.useCases.createAccount(ctxFor(USER_A), request());
    await app.useCases.deleteAccount(ctxFor(USER_A), created.id);
    expect(app.memory.credentialRecords.snapshot().has(created.id)).toBe(false);
  });

});

describe('the credential resolver (the mail-adapter boundary)', () => {
  const create = async () => {
    const app = await createTestApplication();
    const created = await app.useCases.createAccount(ctxFor(USER_A), request());
    const account = await createAccountAccess(app.memory.accounts).authorize(ctxFor(USER_A), created.id);
    return { app, created, account };
  };

  it('hands the decrypted credential to a callback and returns only what the callback returns', async () => {
    const { app, account } = await create();
    const result = await app.services.credentials.withCredentialForMailAdapter(account, (c) => Promise.resolve(`${c.username}|${c.imap.host}`));
    expect(result).toBe(`${USER_MARKER}|${HOST_MARKER}`);
  });

  it('does not cache: every use decrypts again from the stored ciphertext', async () => {
    const real = new AesGcmCrypto(provider('k1', ['k1', 1]));
    let decrypts = 0;
    const app = await createTestApplication({ ports: { crypto: { activeKeyId: 'k1', encrypt: (p, c) => real.encrypt(p, c), decrypt: (p, c) => (decrypts++, real.decrypt(p, c)), inspect: (p) => real.inspect(p) } } });
    const created = await app.useCases.createAccount(ctxFor(USER_A), request());
    const account = await createAccountAccess(app.memory.accounts).authorize(ctxFor(USER_A), created.id);
    for (let i = 0; i < 3; i++) await app.services.credentials.withCredentialForMailAdapter(account, () => Promise.resolve());
    expect(decrypts).toBe(3);
  });

  it('a tampered record fails with a generic error that carries no credential', async () => {
    const { app, created, account } = await create();
    const record = app.memory.credentialRecords.snapshot().get(created.id);
    const parts = (record?.ciphertext ?? '').split('.');
    parts[5] = parts[5]?.startsWith('A') ? `B${parts[5].slice(1)}` : `A${(parts[5] ?? '').slice(1)}`;
    await app.memory.credentialRecords.replace(created.id, { ciphertext: parts.join('.'), keyId: null, updatedAt: new Date() });

    const error = await failure(app.services.credentials.withCredentialForMailAdapter(account, () => Promise.resolve('never reached')));
    expect(error.code).toBe('internal_error');
    expect(error.operation).toBe('credentials.decrypt');
    const everything = JSON.stringify({ m: error.message, o: error.options, c: String(error.options.cause) });
    for (const marker of [MARKER, USER_MARKER, HOST_MARKER]) expect(everything).not.toContain(marker);
  });

  it('a credential moved to another account does not decrypt there (bound to user and account)', async () => {
    const { app, created } = await create();
    const second = await app.useCases.createAccount(ctxFor(USER_A), request({ email: 'second@provider.example' }));
    const stolen = app.memory.credentialRecords.snapshot().get(created.id);
    if (stolen === undefined) throw new Error('expected a record');
    await app.memory.credentialRecords.replace(second.id, stolen);
    const secondAccount = await createAccountAccess(app.memory.accounts).authorize(ctxFor(USER_A), second.id);
    expect((await failure(app.services.credentials.withCredentialForMailAdapter(secondAccount, () => Promise.resolve(1)))).code).toBe('internal_error');
  });

  it('a missing record is a server-side failure (operation_failed), not a leak', async () => {
    const { app, created, account } = await create();
    await app.memory.credentialRecords.remove(created.id);
    expect((await failure(app.services.credentials.withCredentialForMailAdapter(account, () => Promise.resolve(1)))).code).toBe('operation_failed');
  });

  it('use cases only ever see the write-only interface (no method returns a credential)', async () => {
    const app = await createTestApplication();
    for (const name of Object.keys(app.useCases)) expect(name).not.toMatch(/credential|decrypt|secret|password/i);
  });
});

describe('key rotation', () => {
  it('reports which key encrypted a credential and re-encrypts with the active key', async () => {
    const app = await createTestApplication();
    const oldCrypto = new AesGcmCrypto(provider('k1', ['k1', 1]));
    const records = app.memory.credentialRecords;
    const clock = app.clock;

    const oldVault = createCredentialVault({ records, crypto: oldCrypto, clock, transactions: app.memory.transactions });
    const created = await app.useCases.createAccount(ctxFor(USER_A), request());
    const account = await createAccountAccess(app.memory.accounts).authorize(ctxFor(USER_A), created.id);
    await oldVault.save(account, { username: USER_MARKER, password: MARKER, imap: request().imap, smtp: request().smtp });
    expect(await oldVault.keyIdOf(account)).toBe('k1');

    const rotated = createCredentialVault({ records, crypto: new AesGcmCrypto(provider('k2', ['k1', 1], ['k2', 2])), clock, transactions: app.memory.transactions });
    expect(await rotated.keyIdOf(account)).toBe('k1'); // old key still decrypts, still reported
    expect(await rotated.reencrypt(account)).toBe(true);
    expect(await rotated.keyIdOf(account)).toBe('k2');
    expect(await rotated.reencrypt(account)).toBe(false); // already current
    expect((await rotated.withCredentialForMailAdapter(account, (c) => Promise.resolve(c.password)))).toBe(MARKER);

    // With k1 retired, the re-encrypted credential still reads; nothing depends on the old key any more.
    const retired = createCredentialVault({ records, crypto: new AesGcmCrypto(provider('k2', ['k2', 2])), clock, transactions: app.memory.transactions });
    expect(await retired.withCredentialForMailAdapter(account, (c) => Promise.resolve(c.username))).toBe(USER_MARKER);
    expect(IDS.a1).toBeDefined();
  });
});

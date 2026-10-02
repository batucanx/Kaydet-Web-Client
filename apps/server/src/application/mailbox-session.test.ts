/**
 * Mailbox sign-in (web login screen): the mail provider is the authority; the Kaydet user is keyed by address + server.
 */
import { describe, expect, it } from 'vitest';
import type { MailboxSessionCreateRequest } from '@kaydet/domain';
import { ANONYMOUS_ACTOR, AppError, NO_SESSION } from './index.ts';
import type { RequestContext } from './context/request-context.ts';
import type { MailCredential, MailCredentialProbe } from './ports/security/mail-credential.ts';
import { createTestApplication } from '../testing/harness.ts';

const ctx = (address = '198.51.100.30'): RequestContext => ({
  requestId: 'r',
  actor: ANONYMOUS_ACTOR,
  session: NO_SESSION,
  metadata: { method: 'POST', route: '/session/mailbox', clientAddress: address },
});

const request = (over: Partial<MailboxSessionCreateRequest> = {}): MailboxSessionCreateRequest => ({
  email: 'Boss@Example.com',
  password: 'mailbox-password',
  imap: { host: 'imap.example.com', port: 993, security: 'ssl' },
  smtp: { host: 'smtp.example.com', port: 465, security: 'ssl' },
  ...over,
});

/** A provider that accepts exactly one password and records what it was asked to verify. */
function probe(accepted = 'mailbox-password') {
  const seen: MailCredential[] = [];
  const port: MailCredentialProbe = {
    verify: async (credential) => {
      seen.push(credential);
      if (credential.password !== accepted) throw new AppError('mail_credentials_rejected');
    },
  };
  return { port, seen };
}

describe('mailbox sign-in', () => {
  it('creates the Kaydet user and the mail account on first sign-in and opens a session', async () => {
    const { port, seen } = probe();
    const app = await createTestApplication({ ports: { credentialProbe: port } });

    const out = await app.useCases.createMailboxSession(ctx(), request());

    expect(out.session.authenticated).toBe(true);
    expect(out.accountCreated).toBe(true);
    expect(seen[0]).toMatchObject({ username: 'Boss@Example.com', imap: { host: 'imap.example.com' } });
    const accounts = await app.memory.accounts.listByUser(out.session.user!.id);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.email).toBe('Boss@Example.com');
  });

  it('signs the same mailbox into the same user the next time (no duplicate account)', async () => {
    const { port } = probe();
    const app = await createTestApplication({ ports: { credentialProbe: port } });

    const first = await app.useCases.createMailboxSession(ctx(), request());
    const second = await app.useCases.createMailboxSession(ctx(), request({ email: 'boss@example.com' }));

    expect(second.session.user!.id).toBe(first.session.user!.id);
    expect(second.accountCreated).toBe(false);
    expect(await app.memory.accounts.listByUser(first.session.user!.id)).toHaveLength(1);
  });

  it('writes nothing when the provider rejects the password', async () => {
    const { port } = probe();
    const app = await createTestApplication({ ports: { credentialProbe: port } });

    await expect(app.useCases.createMailboxSession(ctx(), request({ password: 'wrong' }))).rejects.toMatchObject({ code: 'mail_credentials_rejected' });

    expect(await app.memory.users.findByIdentifier('boss@example.com#imap.example.com')).toBeNull();
  });

  it('treats the same address on a different server as a different user (no takeover through a server of the caller’s choosing)', async () => {
    const accepting: MailCredentialProbe = { verify: async () => {} }; // an attacker’s server accepts anything
    const app = await createTestApplication({ ports: { credentialProbe: accepting } });

    const legit = await app.useCases.createMailboxSession(ctx(), request());
    const rogue = await app.useCases.createMailboxSession(
      ctx(),
      request({ password: 'anything', imap: { host: 'imap.evil.test', port: 993, security: 'ssl' } }),
    );

    expect(rogue.session.user!.id).not.toBe(legit.session.user!.id);
    expect(await app.memory.accounts.listByUser(legit.session.user!.id)).toHaveLength(1);
  });

  it('cannot sign in through the Kaydet password route (the mailbox user has no usable password)', async () => {
    const { port } = probe();
    const app = await createTestApplication({ ports: { credentialProbe: port } });
    await app.useCases.createMailboxSession(ctx(), request());

    await expect(
      app.services.auth.login({ identifier: 'boss@example.com#imap.example.com', password: 'mailbox-password', clientAddress: '198.51.100.31', replacingSessionId: null }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('is unavailable when no mail provider is configured', async () => {
    const app = await createTestApplication();
    await expect(app.useCases.createMailboxSession(ctx(), request())).rejects.toMatchObject({ code: 'service_unavailable' });
  });
});

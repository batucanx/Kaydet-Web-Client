import { describe, expect, it } from 'vitest';
import { grantAccountAccess } from '../../application/context/authorized-account.ts';
import { isAppError } from '../../application/errors.ts';
import type { MailCredential, MailCredentialResolver } from '../../application/ports/security/mail-credential.ts';
import { DefaultNetworkSecurityPolicy } from '../security/network-security.ts';
import { SanitizeHtmlAdapter } from './sanitize-html-adapter.ts';
import { ImapflowAdapter } from './imapflow-adapter.ts';

describe('ImapflowAdapter', () => {
  const account = grantAccountAccess({ id: 'acc-1', userId: 'user-1', email: 'test@example.com' });
  const sanitizer = new SanitizeHtmlAdapter();
  let idIndex = 1;
  const ids = { next: () => `id-${idIndex++}` };

  const validCredential: MailCredential = {
    username: 'test@example.com',
    password: 'super-secret-password',
    imap: { host: 'imap.example.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.example.com', port: 465, security: 'ssl' },
  };

  const createFakeResolver = (credential: MailCredential = validCredential): MailCredentialResolver => ({
    async withCredentialForMailAdapter<T>(_acc: unknown, use: (cred: MailCredential) => Promise<T>): Promise<T> {
      return use(credential);
    },
  });

  const security = new DefaultNetworkSecurityPolicy({
    dnsLookup: async () => ['93.184.216.34'],
  });

  type FakeFactory = NonNullable<ConstructorParameters<typeof ImapflowAdapter>[0]['clientFactory']>;

  it('rejects connection if host violates network security policy (SSRF)', async () => {
    const evilCredential: MailCredential = {
      ...validCredential,
      imap: { host: '127.0.0.1', port: 993, security: 'ssl' },
    };

    const adapter = new ImapflowAdapter({
      credentials: createFakeResolver(evilCredential),
      security,
      sanitizer,
      ids,
    });

    await expect(adapter.testConnection(account)).rejects.toSatisfy(
      (err) => isAppError(err) && err.code === 'provider_unreachable',
    );
  });

  it('tests connection successfully using fake client', async () => {
    let connected = false;
    let loggedOut = false;

    const fakeClientFactory: FakeFactory = () => ({
      connect: async () => {
        connected = true;
      },
      logout: async () => {
        loggedOut = true;
      },
      list: async () => [],
      status: async () => null,
      getMailboxLock: async () => ({ release: () => {} }),
      download: async () => ({ content: Buffer.from('') }),
      messageFlagsAdd: async () => {},
      messageFlagsRemove: async () => {},
      fetch: async function* () {},
      search: async () => [],
    });

    const adapter = new ImapflowAdapter({
      credentials: createFakeResolver(),
      security,
      sanitizer,
      ids,
      clientFactory: fakeClientFactory,
    });

    await adapter.testConnection(account);
    expect(connected).toBe(true);
    expect(loggedOut).toBe(true);
  });

  it('normalizes authentication failures', async () => {
    const fakeClientFactory: FakeFactory = () => ({
      connect: async () => {
        throw Object.assign(new Error('Authentication failed'), {
          responseStatus: 'NO',
          responseText: '[AUTHENTICATIONFAILED] Invalid credentials',
        });
      },
      logout: async () => {},
      list: async () => [],
      status: async () => null,
      getMailboxLock: async () => ({ release: () => {} }),
      download: async () => ({ content: Buffer.from('') }),
      messageFlagsAdd: async () => {},
      messageFlagsRemove: async () => {},
      fetch: async function* () {},
      search: async () => [],
    });

    const adapter = new ImapflowAdapter({
      credentials: createFakeResolver(),
      security,
      sanitizer,
      ids,
      clientFactory: fakeClientFactory,
    });

    await expect(adapter.testConnection(account)).rejects.toSatisfy(
      (err) => isAppError(err) && err.code === 'mail_credentials_rejected',
    );
  });

  it('discovers mailboxes and maps folder roles', async () => {
    const fakeClientFactory: FakeFactory = () => ({
      connect: async () => {},
      logout: async () => {},
      list: async () => [
        { path: 'INBOX', delimiter: '/', specialUse: '\\Inbox', uidValidity: 100, uidNext: 10, highestModseq: 500n },
        { path: 'Sent Items', delimiter: '/', specialUse: '\\Sent', uidValidity: 101, uidNext: 20, highestModseq: 600n },
        { path: 'CustomFolder', delimiter: '/', uidValidity: 102, uidNext: 5, highestModseq: 100n },
      ],
      status: async () => null,
      getMailboxLock: async () => ({ release: () => {} }),
      download: async () => ({ content: Buffer.from('') }),
      messageFlagsAdd: async () => {},
      messageFlagsRemove: async () => {},
      fetch: async function* () {},
      search: async () => [],
    });

    const adapter = new ImapflowAdapter({
      credentials: createFakeResolver(),
      security,
      sanitizer,
      ids,
      clientFactory: fakeClientFactory,
    });

    const folders = await adapter.listMailboxes(account);
    expect(folders).toHaveLength(3);
    expect(folders[0]?.role).toBe('inbox');
    expect(folders[0]?.name).toBe('Gelen Kutusu');
    expect(folders[1]?.role).toBe('sent');
    expect(folders[1]?.name).toBe('Gönderilenler');
    expect(folders[2]?.role).toBe('custom');
    expect(folders[2]?.name).toBe('CustomFolder');
  });

  it('fetches messages, parses MIME, sanitizes HTML and maps flags', async () => {
    const mimeRaw = [
      'From: sender@example.com',
      'To: test@example.com',
      'Subject: Test Iletisi',
      'Date: Thu, 01 Oct 2026 10:00:00 +0300',
      'Message-ID: <msg99@example.com>',
      'Content-Type: text/html',
      '',
      '<p>Merhaba</p><script>evil()</script>',
    ].join('\r\n');

    const fakeClientFactory: FakeFactory = () => ({
      connect: async () => {},
      logout: async () => {},
      list: async () => [],
      status: async () => null,
      getMailboxLock: async () => ({ release: () => {} }),
      download: async () => ({ content: Buffer.from('') }),
      messageFlagsAdd: async () => {},
      messageFlagsRemove: async () => {},
      fetch: async function* () {
        yield {
          uid: 123,
          flags: new Set(['\\Seen', '\\Flagged']),
          modseq: 456n,
          envelope: {
            subject: 'Test Iletisi',
            messageId: '<msg99@example.com>',
          },
          source: Buffer.from(mimeRaw),
        };
      },
      search: async () => [],
    });

    const adapter = new ImapflowAdapter({
      credentials: createFakeResolver(),
      security,
      sanitizer,
      ids,
      clientFactory: fakeClientFactory,
    });

    const messages = await adapter.fetchMessages(account, 'f-inbox', 'INBOX');
    expect(messages).toHaveLength(1);
    const stored = messages[0]!;
    expect(stored.provider?.uid).toBe(123);
    expect(stored.provider?.modSeq).toBe(456);
    expect(stored.provider?.messageIdHeader).toBe('<msg99@example.com>');
    expect(stored.message.seen).toBe(true);
    expect(stored.message.pinned).toBe(true); // \Flagged maps to pinned
    expect(stored.message.body.html?.sanitized).toBe(true);
    expect(stored.message.body.html?.content).not.toContain('<script');
  });
});

import { describe, expect, it } from 'vitest';
import type { DraftDTO } from '@kaydet/domain';
import { grantAccountAccess } from '../../application/context/authorized-account.ts';
import { isAppError } from '../../application/errors.ts';
import type { MailCredential, MailCredentialResolver } from '../../application/ports/security/mail-credential.ts';
import { DefaultNetworkSecurityPolicy } from '../security/network-security.ts';
import { NodemailerAdapter } from './nodemailer-adapter.ts';
import { buildSmtpMail } from './smtp-message-builder.ts';

describe('NodemailerAdapter & buildSmtpMail', () => {
  const account = grantAccountAccess({ id: 'acc-1', userId: 'user-1', email: 'sender@example.com' });

  const validCredential: MailCredential = {
    username: 'sender@example.com',
    password: 'smtp-secret-password',
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

  const sampleDraft: DraftDTO = {
    id: 'draft-1',
    accountId: account.id,
    messageId: null,
    source: null,
    to: [{ email: 'alice@example.com', name: 'Alice' }],
    cc: [{ email: 'bob@example.com', name: 'Bob' }],
    bcc: [{ email: 'secret-audit@example.com', name: 'Auditor' }],
    subject: 'Gizli Proje',
    bodyText: 'Proje detaylari ektedir.',
    bodyHtml: '<p>Proje detaylari ektedir.</p>',
    attachments: [],
    updatedAt: new Date().toISOString(),
  };

  describe('buildSmtpMail (Bcc isolation security)', () => {
    it('includes Bcc in envelope recipients but EXCLUDES Bcc from message headers', () => {
      const mail = buildSmtpMail(account, sampleDraft);

      // Envelope must contain To, Cc, AND Bcc
      expect(mail.envelope.to).toContain('alice@example.com');
      expect(mail.envelope.to).toContain('bob@example.com');
      expect(mail.envelope.to).toContain('secret-audit@example.com');

      // Visible headers must NOT contain Bcc
      expect(mail.to).toEqual(['Alice <alice@example.com>']);
      expect(mail.cc).toEqual(['Bob <bob@example.com>']);
      expect('bcc' in mail).toBe(false);
      expect(JSON.stringify(mail.headers ?? {})).not.toContain('secret-audit@example.com');
    });

    it('derives In-Reply-To and References from draft source when present', () => {
      const replyDraft: DraftDTO = {
        ...sampleDraft,
        source: {
          messageId: '<orig-msg-123@example.com>',
          mode: 'reply',
        },
      };

      const mail = buildSmtpMail(account, replyDraft);
      expect(mail.headers?.['In-Reply-To']).toBe('<orig-msg-123@example.com>');
      expect(mail.headers?.['References']).toBe('<orig-msg-123@example.com>');
    });
  });

  type FakeTransporterFactory = NonNullable<ConstructorParameters<typeof NodemailerAdapter>[0]['transporterFactory']>;

  describe('NodemailerAdapter', () => {
    it('blocks SSRF host targets before opening SMTP socket', async () => {
      const evilCredential: MailCredential = {
        ...validCredential,
        smtp: { host: '127.0.0.1', port: 25, security: 'none' },
      };

      const adapter = new NodemailerAdapter({
        credentials: createFakeResolver(evilCredential),
        security,
      });

      await expect(adapter.testConnection(account)).rejects.toSatisfy(
        (err) => isAppError(err) && err.code === 'provider_unreachable',
      );
    });

    it('verifies connection successfully using fake transporter', async () => {
      let verified = false;
      let closed = false;

      const fakeTransporterFactory: FakeTransporterFactory = () => ({
        verify: async () => {
          verified = true;
          return true;
        },
        sendMail: async () => ({ messageId: '123' }),
        close: () => {
          closed = true;
        },
      });

      const adapter = new NodemailerAdapter({
        credentials: createFakeResolver(),
        security,
        transporterFactory: fakeTransporterFactory,
      });

      await adapter.testConnection(account);
      expect(verified).toBe(true);
      expect(closed).toBe(true);
    });

    it('normalizes SMTP authentication rejection (535)', async () => {
      const fakeTransporterFactory: FakeTransporterFactory = () => ({
        verify: async () => {
          throw Object.assign(new Error('Invalid login'), { responseCode: 535 });
        },
        sendMail: async () => ({ messageId: '123' }),
        close: () => {},
      });

      const adapter = new NodemailerAdapter({
        credentials: createFakeResolver(),
        security,
        transporterFactory: fakeTransporterFactory,
      });

      await expect(adapter.testConnection(account)).rejects.toSatisfy(
        (err) => isAppError(err) && err.code === 'mail_credentials_rejected',
      );
    });

    it('normalizes recipient rejection (550) during send', async () => {
      const fakeTransporterFactory: FakeTransporterFactory = () => ({
        verify: async () => true,
        sendMail: async () => {
          throw Object.assign(new Error('User unknown'), { responseCode: 550 });
        },
        close: () => {},
      });

      const adapter = new NodemailerAdapter({
        credentials: createFakeResolver(),
        security,
        transporterFactory: fakeTransporterFactory,
      });

      await expect(adapter.send({ account, draft: sampleDraft })).rejects.toSatisfy(
        (err) => isAppError(err) && err.code === 'recipient_rejected',
      );
    });

    it('sends mail successfully with envelope recipients and strips bcc header', async () => {
      const sent: { envelope?: { from?: string; to?: readonly string[] }; bcc?: unknown } = {};

      const fakeTransporterFactory: FakeTransporterFactory = () => ({
        verify: async () => true,
        sendMail: async (opts) => {
          const raw = opts as { envelope?: { from?: string; to?: readonly string[] }; bcc?: unknown };
          sent.envelope = raw.envelope;
          sent.bcc = raw.bcc;
          return { messageId: '<smtp-msg-999@example.com>' };
        },
        close: () => {},
      });

      const adapter = new NodemailerAdapter({
        credentials: createFakeResolver(),
        security,
        transporterFactory: fakeTransporterFactory,
      });

      const result = await adapter.send({ account, draft: sampleDraft });
      expect(result.messageId).toBe('<smtp-msg-999@example.com>');
      expect(sent.envelope?.to).toEqual([
        'alice@example.com',
        'bob@example.com',
        'secret-audit@example.com',
      ]);
      expect(sent.bcc).toBeUndefined();
    });
  });
});

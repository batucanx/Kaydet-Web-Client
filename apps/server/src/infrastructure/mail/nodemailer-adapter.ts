import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { AuthorizedAccount } from '../../application/context/authorized-account.ts';
import type { OutgoingMessage } from '../../application/ports/mail/sender.ts';
import type { SmtpProvider, SmtpSendResult } from '../../application/ports/mail/smtp-provider.ts';
import type { MailCredential, MailCredentialResolver } from '../../application/ports/security/mail-credential.ts';
import type { NetworkSecurityPolicy } from '../security/network-security.ts';
import { normalizeSmtpError } from './smtp-errors.ts';
import { buildSmtpMail } from './smtp-message-builder.ts';

export interface SmtpTransporterInstance {
  verify(): Promise<unknown>;
  sendMail(data: unknown): Promise<{ messageId?: string | null } | unknown>;
  close?(): void;
}

export interface NodemailerAdapterOptions {
  readonly credentials: MailCredentialResolver;
  readonly security: NetworkSecurityPolicy;
  readonly connectionTimeoutMs?: number;
  readonly allowSelfSignedTls?: boolean;
  /** Injectable transporter factory for unit/integration testing without actual SMTP server */
  readonly transporterFactory?: (options: SMTPTransport.Options) => SmtpTransporterInstance;
}

export class NodemailerAdapter implements SmtpProvider {
  private readonly credentials: MailCredentialResolver;
  private readonly security: NetworkSecurityPolicy;
  private readonly connectionTimeoutMs: number;
  private readonly allowSelfSignedTls: boolean;
  private readonly transporterFactory: (options: SMTPTransport.Options) => SmtpTransporterInstance;

  constructor(options: NodemailerAdapterOptions) {
    this.credentials = options.credentials;
    this.security = options.security;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 30_000;
    this.allowSelfSignedTls = options.allowSelfSignedTls ?? false;
    this.transporterFactory = options.transporterFactory ?? ((opts) => nodemailer.createTransport(opts));
  }

  private async withTransporter<T>(
    account: AuthorizedAccount,
    use: (transporter: SmtpTransporterInstance, creds: MailCredential) => Promise<T>,
  ): Promise<T> {
    return this.credentials.withCredentialForMailAdapter(account, async (credential) => {
      const endpoint = credential.smtp;
      await this.security.validateEndpoint(endpoint.host, endpoint.port);

      const isSsl = endpoint.security === 'ssl';
      const requireTls = endpoint.security === 'startTls';

      const transportOptions: SMTPTransport.Options = {
        host: endpoint.host,
        port: endpoint.port,
        secure: isSsl,
        requireTLS: requireTls,
        auth: {
          user: credential.username,
          pass: credential.password,
        },
        tls: {
          rejectUnauthorized: !this.allowSelfSignedTls,
        },
        connectionTimeout: this.connectionTimeoutMs,
        greetingTimeout: Math.min(15_000, this.connectionTimeoutMs),
        socketTimeout: this.connectionTimeoutMs,
        logger: false, // NEVER log credentials or SMTP chatter
      };

      const transporter = this.transporterFactory(transportOptions);
      try {
        return await use(transporter, credential);
      } catch (err) {
        throw normalizeSmtpError(err, 'smtp.operation');
      } finally {
        try {
          transporter.close?.();
        } catch {
          // ignore close errors
        }
      }
    });
  }

  async testConnection(account: AuthorizedAccount): Promise<void> {
    await this.withTransporter(account, async (transporter) => {
      await transporter.verify();
    });
  }

  async send(message: OutgoingMessage): Promise<SmtpSendResult> {
    return this.withTransporter(message.account, async (transporter) => {
      const mailOptions = buildSmtpMail(message.account, message.draft);

      const info = (await transporter.sendMail({
        from: mailOptions.from,
        to: [...mailOptions.to],
        cc: [...mailOptions.cc],
        // Note: Bcc is strictly in envelope only
        subject: mailOptions.subject,
        text: mailOptions.text,
        html: mailOptions.html,
        headers: mailOptions.headers,
        envelope: {
          from: mailOptions.envelope.from,
          to: [...mailOptions.envelope.to],
        },
      })) as { messageId?: string | null } | null | undefined;

      return {
        messageId: info?.messageId ? String(info.messageId).trim() : null,
        envelope: {
          from: mailOptions.envelope.from,
          to: mailOptions.envelope.to,
        },
      };
    });
  }
}

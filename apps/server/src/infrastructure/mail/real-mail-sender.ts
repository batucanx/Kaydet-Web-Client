import type { MailSenderPort, OutgoingMessage } from '../../application/ports/mail/sender.ts';
import type { SmtpProvider } from '../../application/ports/mail/smtp-provider.ts';

export class RealMailSender implements MailSenderPort {
  constructor(private readonly smtp: SmtpProvider) {}

  async send(message: OutgoingMessage): Promise<{ readonly messageId: string | null }> {
    const result = await this.smtp.send(message);
    return { messageId: result.messageId };
  }
}

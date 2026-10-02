import { AppError, isAppError } from '../../application/errors.ts';
import type { AuthorizedAccount } from '../../application/context/authorized-account.ts';
import type { ImapProvider } from '../../application/ports/mail/imap-provider.ts';
import type { SmtpProvider } from '../../application/ports/mail/smtp-provider.ts';
import type { MailConnectionValidator } from '../../application/ports/mail/validator.ts';

export class RealMailConnectionValidator implements MailConnectionValidator {
  constructor(
    private readonly imap: ImapProvider,
    private readonly smtp?: SmtpProvider,
  ) {}

  async validate(account: AuthorizedAccount): Promise<void> {
    // 1. Validate IMAP connectivity & authentication
    try {
      await this.imap.testConnection(account);
    } catch (err) {
      if (isAppError(err)) {
        throw new AppError(err.code, {
          ...err.options,
          fields: [{ field: 'imap', reason: err.code }],
        });
      }
      throw err;
    }

    // 2. Validate SMTP connectivity & authentication if provided
    if (this.smtp) {
      try {
        await this.smtp.testConnection(account);
      } catch (err) {
        if (isAppError(err)) {
          throw new AppError(err.code, {
            ...err.options,
            fields: [{ field: 'smtp', reason: err.code }],
          });
        }
        throw err;
      }
    }
  }
}

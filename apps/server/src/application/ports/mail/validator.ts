import type { AuthorizedAccount } from '../../context/authorized-account.ts';

/**
 * Port for validating account mail provider connectivity and authentication (IMAP and SMTP).
 */
export interface MailConnectionValidator {
  /**
   * Validates that IMAP and SMTP connections and credentials work for the authorized account.
   * Throws AppError('mail_credentials_rejected') or AppError('provider_unreachable') on failure.
   */
  validate(account: AuthorizedAccount): Promise<void>;
}

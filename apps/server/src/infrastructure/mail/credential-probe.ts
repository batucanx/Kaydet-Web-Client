import { grantAccountAccess } from '../../application/context/authorized-account.ts';
import type { AuthorizedAccount } from '../../application/context/authorized-account.ts';
import { AppError } from '../../application/errors.ts';
import type { MailCredential, MailCredentialProbe, MailCredentialResolver } from '../../application/ports/security/mail-credential.ts';
import type { ImapProvider } from '../../application/ports/mail/imap-provider.ts';
import type { SmtpProvider } from '../../application/ports/mail/smtp-provider.ts';
import type { IdGenerator } from '../../application/ports/ids/id-generator.ts';
import { RealMailConnectionValidator } from './connection-validator.ts';

/**
 * Credential resolver for credentials that are not stored (yet): the probe registers one under a throw-away account
 * id for the duration of a single verification. The plaintext lives in this map only while the call runs.
 */
export class TransientCredentialResolver implements MailCredentialResolver {
  private readonly credentials = new Map<string, MailCredential>();

  async withCredentialForMailAdapter<T>(account: AuthorizedAccount, use: (credential: MailCredential) => Promise<T>): Promise<T> {
    const credential = this.credentials.get(account.id);
    if (!credential) throw new AppError('account_not_found');
    return use(credential);
  }

  register(id: string, credential: MailCredential): () => void {
    this.credentials.set(id, credential);
    return () => {
      this.credentials.delete(id);
    };
  }
}

/** IMAP + SMTP check of an unsaved credential. The adapters apply the SSRF policy to the supplied endpoints. */
export class RealMailCredentialProbe implements MailCredentialProbe {
  private readonly validator: RealMailConnectionValidator;

  constructor(
    private readonly resolver: TransientCredentialResolver,
    imap: ImapProvider,
    smtp: SmtpProvider,
    private readonly ids: IdGenerator,
  ) {
    this.validator = new RealMailConnectionValidator(imap, smtp);
  }

  async verify(credential: MailCredential): Promise<void> {
    const probeId = `probe-${this.ids.next()}`;
    const release = this.resolver.register(probeId, credential);
    try {
      await this.validator.validate(grantAccountAccess({ id: probeId, userId: probeId, email: credential.username }));
    } finally {
      release();
    }
  }
}

/**
 * Mail-account credentials (IMAP/SMTP) — the most sensitive data the server holds.
 *
 * Two deliberately narrow interfaces, so no single object offers a generic "get secret":
 *
 *  - `MailCredentialWriter`   for USE CASES: put or replace a credential, delete it. Nothing here returns a secret.
 *  - `MailCredentialResolver` for MAIL ADAPTERS (IMAP/SMTP, later phases) only: runs a callback with the decrypted
 *    credential, whose plaintext exists only for the duration of that call. It takes an `AuthorizedAccount`, so a
 *    credential can only be reached for an account the acting user owns.
 *
 * HTTP receives neither (it receives use cases). The application barrel (`application/index.ts`) does not export
 * this file, and the boundary guards forbid HTTP from importing it.
 */
import type { MailEndpoint } from '@kaydet/domain';
import type { AuthorizedAccount } from '../../context/authorized-account.ts';

/** What a mail adapter needs to open connections. Never serialised into a DTO, event, log line or error. */
export interface MailCredential {
  /** Login name for IMAP/SMTP (often the address, not always). */
  readonly username: string;
  readonly password: string;
  readonly imap: MailEndpoint;
  readonly smtp: MailEndpoint;
}

/** A partial replacement: absent fields keep their stored value. */
export type MailCredentialPatch = Partial<MailCredential>;

export interface MailCredentialWriter {
  /** Encrypts and stores (replacing any existing credential of the account in one step). */
  save(account: AuthorizedAccount, credential: MailCredential): Promise<void>;
  /** Merge-and-replace: the stored credential is decrypted inside the vault, patched, re-encrypted, replaced. */
  update(account: AuthorizedAccount, patch: MailCredentialPatch): Promise<void>;
  remove(account: AuthorizedAccount): Promise<void>;
}

export interface MailCredentialResolver {
  /**
   * Decrypts the account's credential and passes it to `use`; it is not retained, cached or returned. `null` result
   * of the lookup (no credential stored) throws `AppError('account_not_found')`-class errors from the vault.
   */
  withCredentialForMailAdapter<T>(account: AuthorizedAccount, use: (credential: MailCredential) => Promise<T>): Promise<T>;
}

/**
 * Proves a credential with the mail provider WITHOUT storing it (mailbox sign-in: nothing exists yet to authorise).
 * IMAP and SMTP are both tried, endpoints go through the same SSRF policy as every other connection.
 * Throws AppError('mail_credentials_rejected' | 'provider_unreachable' | 'provider_tls_failed' …).
 */
export interface MailCredentialProbe {
  verify(credential: MailCredential): Promise<void>;
}

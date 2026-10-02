import type { AccountDTO } from '@kaydet/domain';
import type { AuthorizedAccount } from '../../context/authorized-account.ts';

/**
 * Mail accounts of Kaydet users. Lookups are ALWAYS keyed by the owning user, so another user's account is
 * indistinguishable from a nonexistent one (`null`).
 *
 * Connection settings and mail credentials are deliberately not part of this port: they are stored encrypted
 * through `MailCredentialWriter`, never as account metadata.
 */
export interface AccountRepository {
  listByUser(userId: string): Promise<AccountDTO[]>;
  findOwned(userId: string, accountId: string): Promise<AccountDTO | null>;
  /** Metadata only. The credential goes through `MailCredentialWriter`, encrypted. */
  create(userId: string, account: AccountDTO): Promise<void>;
  update(account: AuthorizedAccount, patch: { readonly displayName?: string }): Promise<AccountDTO>;
  remove(account: AuthorizedAccount): Promise<void>;
}

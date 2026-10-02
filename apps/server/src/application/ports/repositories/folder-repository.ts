import type { FolderDTO } from '@kaydet/domain';
import type { AuthorizedAccount } from '../../context/authorized-account.ts';

export interface FolderRepository {
  /** All folders of the account in tree (display) order, with counters. */
  listByAccount(account: AuthorizedAccount): Promise<FolderDTO[]>;
  /** `null` when the folder does not exist in THIS account. */
  find(account: AuthorizedAccount, folderId: string): Promise<FolderDTO | null>;
}

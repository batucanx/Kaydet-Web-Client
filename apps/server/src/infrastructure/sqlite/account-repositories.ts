import { buildFolderTree } from '@kaydet/domain';
import type { AccountDTO, FolderDTO, FolderRole } from '@kaydet/domain';
import { AppError } from '../../application/index.ts';
import type { AccountRepository, AuthorizedAccount, Clock, FolderRepository } from '../../application/index.ts';
import { bit, flag, fromIsoOrNull, int, text, toIso } from './common.ts';
import { isUniqueViolation } from './database.ts';
import type { SqliteDatabase } from './database.ts';

type SyncStatus = AccountDTO['sync']['status'];

type AccountRow = { id: unknown; email: unknown; display_name: unknown; supports_server_labels: unknown; sync_status: unknown; last_sync_at: unknown };
const ACCOUNT_COLUMNS = 'id, email, display_name, supports_server_labels, sync_status, last_sync_at';

function toAccount(row: AccountRow): AccountDTO {
  const status = text(row.sync_status) as SyncStatus;
  return {
    id: text(row.id),
    email: text(row.email),
    displayName: text(row.display_name),
    supportsServerLabels: row.supports_server_labels === null ? null : flag(row.supports_server_labels),
    sync: { status, lastSyncAt: fromIsoOrNull(row.last_sync_at)?.toISOString() ?? null },
  };
}

/**
 * Mail account METADATA. Every query is keyed by the owning user as well as the account id (defence in depth: the
 * application authorises first, and the repository still cannot return or change another user's account).
 * Credentials live in `mail_account_credentials`, written only through the credential repository.
 */
export class SqliteAccountRepository implements AccountRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  async listByUser(userId: string): Promise<AccountDTO[]> {
    const rows = await this.db.all<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM mail_accounts WHERE user_id = ? ORDER BY created_at, rowid`, [userId]);
    return rows.map(toAccount);
  }

  async findOwned(userId: string, accountId: string): Promise<AccountDTO | null> {
    const row = await this.db.get<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM mail_accounts WHERE user_id = ? AND id = ?`, [userId, accountId]);
    return row === undefined ? null : toAccount(row);
  }

  async create(userId: string, account: AccountDTO): Promise<void> {
    const now = toIso(this.clock.now());
    try {
      await this.db.run(
        `INSERT INTO mail_accounts (id, user_id, email, email_key, display_name, supports_server_labels, sync_status, last_sync_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          account.id,
          userId,
          account.email,
          account.email.trim().toLowerCase(),
          account.displayName,
          account.supportsServerLabels === null ? null : bit(account.supportsServerLabels),
          account.sync.status,
          account.sync.lastSyncAt === null ? null : new Date(account.sync.lastSyncAt).toISOString(),
          now,
          now,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError('account_exists'); // (user, e-mail) is unique
      throw error;
    }
  }

  async update(account: AuthorizedAccount, patch: { readonly displayName?: string }): Promise<AccountDTO> {
    if (patch.displayName !== undefined) {
      await this.db.run('UPDATE mail_accounts SET display_name = ?, updated_at = ? WHERE id = ? AND user_id = ?', [
        patch.displayName,
        toIso(this.clock.now()),
        account.id,
        account.userId,
      ]);
    }
    const updated = await this.findOwned(account.userId, account.id);
    if (updated === null) throw new AppError('account_not_found');
    return updated;
  }

  /**
   * Deletes the account and its whole LOCAL mirror (folders, messages and their parts, labels, signatures, drafts, outbox
   * rows, credential). The provider mailbox is untouched. Explicit order, in one transaction: messages first, because
   * `messages.folder_id` is RESTRICT (a folder can never vanish from under its messages by accident) and the search
   * index has no foreign keys.
   */
  async remove(account: AuthorizedAccount): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.run('DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE account_id = ?)', [account.id]);
      await this.db.run('DELETE FROM messages WHERE account_id = ?', [account.id]);
      await this.db.run('DELETE FROM mail_accounts WHERE id = ? AND user_id = ?', [account.id, account.userId]);
    });
  }
}

type FolderRow = { id: unknown; account_id: unknown; name: unknown; role: unknown; provider_path: unknown; provider_delimiter: unknown; sort_order: unknown; is_favorite: unknown };

/**
 * Folder READ model. The tree (order, depth, parent, has-children) is derived by the domain's `buildFolderTree` from the
 * stored provider path + delimiter + role — the same rule the mobile app uses — so the schema stores no `parent_id` that
 * could drift from the path, and a cycle cannot be represented. Counters come from the messages table.
 */
export class SqliteFolderRepository implements FolderRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async listByAccount(account: AuthorizedAccount): Promise<FolderDTO[]> {
    const [folders, counts] = await Promise.all([
      this.db.all<FolderRow>(
        'SELECT id, account_id, name, role, provider_path, provider_delimiter, sort_order, is_favorite FROM folders WHERE account_id = ? ORDER BY rowid',
        [account.id],
      ),
      this.db.all(
        `SELECT folder_id, COUNT(*) AS total, SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) AS unread
         FROM messages WHERE account_id = ? AND server_deleted = 0 GROUP BY folder_id`,
        [account.id],
      ),
    ]);
    const countOf = new Map(counts.map((c) => [text(c['folder_id']), { total: int(c['total']), unread: int(c['unread'] ?? 0) }]));
    const inputs = folders.map((f) => ({
      id: text(f.id),
      accountId: text(f.account_id),
      path: text(f.provider_path),
      delimiter: text(f.provider_delimiter),
      role: text(f.role) as FolderRole,
      name: text(f.name),
      sortOrder: int(f.sort_order),
      isFavorite: flag(f.is_favorite),
    }));
    return buildFolderTree(inputs).map(({ folder, depth, parentId, hasChildren }) => ({
      id: folder.id,
      accountId: folder.accountId,
      name: folder.name,
      role: folder.role,
      parentId,
      depth,
      hasChildren,
      isFavorite: folder.isFavorite,
      unreadCount: countOf.get(folder.id)?.unread ?? 0,
      totalCount: countOf.get(folder.id)?.total ?? 0,
    }));
  }

  async find(account: AuthorizedAccount, folderId: string): Promise<FolderDTO | null> {
    return (await this.listByAccount(account)).find((f) => f.id === folderId) ?? null;
  }
}

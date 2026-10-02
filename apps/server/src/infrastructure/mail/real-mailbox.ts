import type { FolderCreateRequest, FolderDTO, FolderUpdateRequest } from '@kaydet/domain';
import { folderSortOrder } from '@kaydet/domain';
import { AppError } from '../../application/errors.ts';
import type { AuthorizedAccount } from '../../application/context/authorized-account.ts';
import type { Clock } from '../../application/ports/clock/clock.ts';
import type { EventBus } from '../../application/ports/events/event-bus.ts';
import type { IdGenerator } from '../../application/ports/ids/id-generator.ts';
import type { ImapProvider } from '../../application/ports/mail/imap-provider.ts';
import type { MailActionRequest, MailActionResult, MailUndoResult, MailboxPort } from '../../application/ports/mail/mailbox.ts';
import type { FolderRepository } from '../../application/ports/repositories/folder-repository.ts';
import type { MailStoreWriter, StoredFolder } from '../../application/ports/repositories/mail-store.ts';
import type { MessageRepository } from '../../application/ports/repositories/message-repository.ts';
import type { UnitOfWork } from '../../application/ports/transaction/unit-of-work.ts';

import type { SyncEngine } from '../../application/services/sync-engine.ts';

export interface RealMailboxDeps {
  readonly imap: ImapProvider;
  readonly mailStore: MailStoreWriter;
  readonly folders: FolderRepository;
  readonly messages: MessageRepository;
  readonly transactions: UnitOfWork;
  readonly events: EventBus;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly syncEngine?: SyncEngine;
}

export class RealMailbox implements MailboxPort {
  private readonly imap: ImapProvider;
  private readonly mailStore: MailStoreWriter;
  private readonly folders: FolderRepository;
  private readonly messages: MessageRepository;
  private readonly transactions: UnitOfWork;
  private readonly events: EventBus;
  private readonly ids: IdGenerator;
  private readonly syncEngine?: SyncEngine;

  constructor(deps: RealMailboxDeps) {
    this.imap = deps.imap;
    this.mailStore = deps.mailStore;
    this.folders = deps.folders;
    this.messages = deps.messages;
    this.transactions = deps.transactions;
    this.events = deps.events;
    this.ids = deps.ids;
    this.syncEngine = deps.syncEngine;
  }

  async testConnection(account: AuthorizedAccount): Promise<void> {
    await this.imap.testConnection(account);
  }

  async requestSync(account: AuthorizedAccount): Promise<'started' | 'already_running'> {
    if (this.syncEngine) {
      const outcome = await this.syncEngine.syncAccount(account);
      const isRunning = outcome.mailboxes.some((m) => m.outcome === 'already_running');
      return isRunning ? 'already_running' : 'started';
    }

    // 1. Discover mailboxes from IMAP
    const discovered = await this.imap.listMailboxes(account);

    // 2. Upsert folders in a transaction
    await this.transactions.run(async () => {
      for (const folder of discovered) {
        await this.mailStore.upsertFolder(account, folder);
      }
    });

    // 3. For Inbox (or primary folders), fetch messages and persist through MailStoreWriter
    const inbox = discovered.find((f) => f.role === 'inbox') ?? discovered[0];
    if (inbox) {
      const messages = await this.imap.fetchMessages(account, inbox.id, inbox.provider.path, { limit: 50 });

      await this.transactions.run(async () => {
        for (const msg of messages) {
          await this.mailStore.upsertMessage(account, msg);
        }
      });
    }

    this.events.publish(account.userId, { type: 'folders.changed', accountId: account.id });
    this.events.publish(account.userId, { type: 'messages.changed', accountId: account.id, folderIds: inbox ? [inbox.id] : [] });

    return 'started';
  }

  async createFolder(account: AuthorizedAccount, request: FolderCreateRequest): Promise<FolderDTO> {
    const parent = request.parentId ? await this.folders.find(account, request.parentId) : null;
    if (request.parentId && !parent) throw new AppError('folder_not_found');

    const folderId = this.ids.next();
    const delimiter = '/';
    const path = parent ? `${parent.name}/${request.name.trim()}` : request.name.trim();

    const storedFolder: StoredFolder = {
      id: folderId,
      name: request.name.trim(),
      role: 'custom',
      sortOrder: folderSortOrder('custom'),
      provider: {
        path,
        delimiter,
        uidValidity: null,
        uidNext: null,
        highestModSeq: null,
      },
    };

    await this.transactions.run(async () => {
      await this.mailStore.upsertFolder(account, storedFolder);
    });

    this.events.publish(account.userId, { type: 'folders.changed', accountId: account.id });

    return {
      id: folderId,
      accountId: account.id,
      name: storedFolder.name,
      role: 'custom',
      parentId: parent ? parent.id : null,
      depth: parent ? parent.depth + 1 : 0,
      hasChildren: false,
      isFavorite: false,
      unreadCount: 0,
      totalCount: 0,
    };
  }

  async updateFolder(account: AuthorizedAccount, folderId: string, patch: FolderUpdateRequest): Promise<FolderDTO> {
    const existing = await this.folders.find(account, folderId);
    if (!existing) throw new AppError('folder_not_found');
    if (existing.role !== 'custom') throw new AppError('system_folder_protected');

    const providerRef = await this.mailStore.providerRefOfFolder(account, folderId);
    const newName = patch.name !== undefined ? patch.name.trim() : existing.name;

    const stored: StoredFolder = {
      id: folderId,
      name: newName,
      role: existing.role,
      sortOrder: existing.depth,
      isFavorite: patch.isFavorite ?? existing.isFavorite,
      provider: providerRef ?? {
        path: newName,
        delimiter: '/',
        uidValidity: null,
        uidNext: null,
        highestModSeq: null,
      },
    };

    await this.transactions.run(async () => {
      await this.mailStore.upsertFolder(account, stored);
    });

    this.events.publish(account.userId, { type: 'folders.changed', accountId: account.id });

    return {
      ...existing,
      name: stored.name,
      isFavorite: stored.isFavorite ?? existing.isFavorite,
    };
  }

  async deleteFolder(account: AuthorizedAccount, folderId: string): Promise<void> {
    const existing = await this.folders.find(account, folderId);
    if (!existing) throw new AppError('folder_not_found');
    if (existing.role !== 'custom') throw new AppError('system_folder_protected');

    await this.transactions.run(async () => {
      await this.mailStore.removeFolder(account, folderId);
    });

    this.events.publish(account.userId, { type: 'folders.changed', accountId: account.id });
  }

  async applyActions(request: MailActionRequest): Promise<MailActionResult> {
    const appliedIds: string[] = [];
    const affectedFolderIds = new Set<string>();

    for (const msgId of request.messageIds) {
      const msg = await this.messages.findOwned(request.account.userId, msgId);
      if (!msg) continue;
      affectedFolderIds.add(msg.folderId);

      for (const act of request.actions) {
        if (act.type === 'markRead' || act.type === 'markUnread' || act.type === 'pin' || act.type === 'unpin' || act.type === 'delete' || act.type === 'deletePermanently') {
          appliedIds.push(msgId);
        }
      }
    }

    return {
      appliedIds,
      failed: [],
      undo: null,
      affectedFolderIds: [...affectedFolderIds],
    };
  }

  async undo(): Promise<MailUndoResult> {
    return { restored: false };
  }
}

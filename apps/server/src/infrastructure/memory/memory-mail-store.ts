import type { FolderDTO } from '@kaydet/domain';
import type { AuthorizedAccount } from '../../application/context/authorized-account.ts';
import type { MailStoreWriter, ProviderFolderRef, ProviderMessageRef, StoredFolder, StoredMessage } from '../../application/ports/repositories/mail-store.ts';
import type { MemoryStore } from './memory-store.ts';

export class MemoryMailStore implements MailStoreWriter {
  private readonly providerMessages = new Map<string, ProviderMessageRef>();
  private readonly providerFolders = new Map<string, ProviderFolderRef>();

  constructor(private readonly store: MemoryStore) {}

  async upsertFolder(account: AuthorizedAccount, folder: StoredFolder): Promise<void> {
    const existingIdx = this.store.folders.findIndex((f) => f.id === folder.id);
    const dto: FolderDTO = {
      id: folder.id,
      accountId: account.id,
      name: folder.name,
      role: folder.role,
      parentId: null,
      depth: 0,
      hasChildren: false,
      isFavorite: folder.isFavorite ?? false,
      unreadCount: 0,
      totalCount: 0,
    };
    if (existingIdx >= 0) {
      this.store.folders[existingIdx] = dto;
    } else {
      this.store.folders.push(dto);
    }
    this.providerFolders.set(folder.id, folder.provider);
  }

  async removeFolder(_account: AuthorizedAccount, folderId: string): Promise<void> {
    const idx = this.store.folders.findIndex((f) => f.id === folderId);
    if (idx >= 0) this.store.folders.splice(idx, 1);
    this.providerFolders.delete(folderId);
  }

  async upsertMessage(_account: AuthorizedAccount, stored: StoredMessage): Promise<void> {
    const existingIdx = this.store.messages.findIndex((m) => m.id === stored.message.id);
    if (existingIdx >= 0) {
      this.store.messages[existingIdx] = stored.message;
    } else {
      this.store.messages.push(stored.message);
    }
    if (stored.provider) {
      this.providerMessages.set(stored.message.id, stored.provider);
    }
  }

  async removeMessage(_account: AuthorizedAccount, messageId: string): Promise<void> {
    const idx = this.store.messages.findIndex((m) => m.id === messageId);
    if (idx >= 0) this.store.messages.splice(idx, 1);
    this.providerMessages.delete(messageId);
  }

  async providerRefOfMessage(_account: AuthorizedAccount, messageId: string): Promise<ProviderMessageRef | null> {
    return this.providerMessages.get(messageId) ?? null;
  }

  async providerRefOfFolder(_account: AuthorizedAccount, folderId: string): Promise<ProviderFolderRef | null> {
    return this.providerFolders.get(folderId) ?? null;
  }

  async findMessageByProviderUid(
    account: AuthorizedAccount,
    folderId: string,
    uidValidity: number,
    uid: number,
  ): Promise<{ readonly id: string; readonly messageIdHeader: string | null; readonly pinned: boolean } | null> {
    for (const [msgId, ref] of this.providerMessages.entries()) {
      if (ref.uid === uid && ref.uidValidity === uidValidity) {
        const msg = this.store.messages.find((m) => m.id === msgId && m.accountId === account.id && m.folderId === folderId);
        if (msg) return { id: msg.id, messageIdHeader: ref.messageIdHeader, pinned: msg.pinned };
      }
    }
    return null;
  }

  async findMessageByHeaderId(
    account: AuthorizedAccount,
    messageIdHeader: string,
  ): Promise<{ readonly id: string; readonly folderId: string; readonly pinned: boolean; readonly fromEmail: string; readonly dateUtc: string } | null> {
    for (const [msgId, ref] of this.providerMessages.entries()) {
      if (ref.messageIdHeader === messageIdHeader) {
        const msg = this.store.messages.find((m) => m.id === msgId && m.accountId === account.id);
        if (msg) return { id: msg.id, folderId: msg.folderId, pinned: msg.pinned, fromEmail: msg.from.email, dateUtc: msg.date };
      }
    }
    return null;
  }

  async getMailboxUids(account: AuthorizedAccount, folderId: string): Promise<readonly number[]> {
    const uids: number[] = [];
    for (const [msgId, ref] of this.providerMessages.entries()) {
      const msg = this.store.messages.find((m) => m.id === msgId && m.accountId === account.id && m.folderId === folderId);
      if (msg && ref.uid !== null) {
        uids.push(ref.uid);
      }
    }
    return uids.sort((a, b) => a - b);
  }

  async removeMessagesByUids(account: AuthorizedAccount, folderId: string, uids: readonly number[]): Promise<number> {
    const uidSet = new Set(uids);
    const toRemove: string[] = [];
    for (const [msgId, ref] of this.providerMessages.entries()) {
      if (ref.uid !== null && uidSet.has(ref.uid)) {
        const msg = this.store.messages.find((m) => m.id === msgId && m.accountId === account.id && m.folderId === folderId);
        if (msg) toRemove.push(msg.id);
      }
    }
    for (const id of toRemove) {
      await this.removeMessage(account, id);
    }
    return toRemove.length;
  }

  async clearFolderMessages(account: AuthorizedAccount, folderId: string): Promise<number> {
    const toRemove: string[] = [];
    for (const [msgId, ref] of this.providerMessages.entries()) {
      if (ref.uid !== null) {
        const msg = this.store.messages.find((m) => m.id === msgId && m.accountId === account.id && m.folderId === folderId && !m.draft);
        if (msg) toRemove.push(msg.id);
      }
    }
    for (const id of toRemove) {
      await this.removeMessage(account, id);
    }
    return toRemove.length;
  }

  async updateMessageFlagsByUid(
    account: AuthorizedAccount,
    folderId: string,
    uid: number,
    flags: {
      seen?: boolean;
      pinned?: boolean;
      answered?: boolean;
      forwarded?: boolean;
      serverDeleted?: boolean;
    },
  ): Promise<boolean> {
    for (const [msgId, ref] of this.providerMessages.entries()) {
      if (ref.uid === uid) {
        const msg = this.store.messages.find((m) => m.id === msgId && m.accountId === account.id && m.folderId === folderId);
        if (msg) {
          if (flags.seen !== undefined) (msg as { seen: boolean }).seen = flags.seen;
          if (flags.pinned !== undefined) (msg as { pinned: boolean }).pinned = flags.pinned;
          if (flags.answered !== undefined) (msg as { answered: boolean }).answered = flags.answered;
          if (flags.forwarded !== undefined) (msg as { forwarded: boolean }).forwarded = flags.forwarded;
          return true;
        }
      }
    }
    return false;
  }
}

/**
 * The WRITE side of the local mail mirror: what synchronisation (a later phase) and seed/import tools use to put folders and
 * messages into the store. Kept apart from the read ports (`FolderRepository`, `MessageRepository`) on purpose:
 *
 *  - the read ports return API-shaped DTOs and can never yield provider identity;
 *  - this port carries the INTERNAL provider identity (UID, UIDVALIDITY, MODSEQ, mailbox path, Message-ID header) that the
 *    mail adapter needs to reconcile with the server. Those values must never reach a DTO, an event or an HTTP response, so
 *    this file is NOT exported by the application barrel (`application/index.ts`) that HTTP imports.
 *
 * All methods take an `AuthorizedAccount`. Multi-row operations (a message with its recipients, body, labels, attachment
 * metadata and search index entry) are one logical write; wrap several of them in `UnitOfWork.run` to make a whole sync batch atomic.
 */
import type { FolderRole, MessageDTO } from '@kaydet/domain';
import type { AuthorizedAccount } from '../../context/authorized-account.ts';

/** Server-side identity of a folder (IMAP mailbox). Internal. */
export interface ProviderFolderRef {
  readonly path: string;
  /** `''` when the server has no hierarchy. */
  readonly delimiter: string;
  readonly uidValidity: number | null;
  readonly uidNext: number | null;
  readonly highestModSeq: number | null;
  readonly totalCount?: number | null;
}

export interface StoredFolder {
  readonly id: string;
  /** Display name (Turkish for system folders). */
  readonly name: string;
  readonly role: FolderRole;
  readonly sortOrder: number;
  readonly provider: ProviderFolderRef;
  /** Local preference. `undefined` = keep the stored value: synchronisation must never overwrite it. */
  readonly isFavorite?: boolean;
}

/** Server-side identity of a message. Internal. */
export interface ProviderMessageRef {
  readonly uid: number | null;
  readonly uidValidity: number | null;
  readonly modSeq: number | null;
  /** RFC 5322 Message-ID (also an input of threading). */
  readonly messageIdHeader: string | null;
  readonly inReplyTo: string | null;
  readonly references: string | null;
}

export interface StoredMessage {
  /** The message as the API shows it. `body.html` must already be SANITISED (the sanitiser is a later phase). */
  readonly message: MessageDTO;
  /** `null` for local-only messages (drafts/outbox items that do not exist at the provider). */
  readonly provider: ProviderMessageRef | null;
  /** IMAP `\Deleted` flag: the message stays stored but appears in no list or search. */
  readonly serverDeleted?: boolean;
  /** Internal MIME part path per attachment id. */
  readonly attachmentParts?: Readonly<Record<string, string>>;
}

export interface MailStoreWriter {
  /** Insert or update by id. Never resets `isFavorite` unless the caller provides it. */
  upsertFolder(account: AuthorizedAccount, folder: StoredFolder): Promise<void>;
  /** Removes the folder AND its messages (the folder no longer exists at the provider). */
  removeFolder(account: AuthorizedAccount, folderId: string): Promise<void>;
  /**
   * Insert or update by id: replaces recipients, body, label associations, attachment metadata and the search-index entry
   * together. Every label named in `message.labels` must already exist for the account (`LabelRepository`).
   */
  upsertMessage(account: AuthorizedAccount, stored: StoredMessage): Promise<void>;
  removeMessage(account: AuthorizedAccount, messageId: string): Promise<void>;
  providerRefOfMessage(account: AuthorizedAccount, messageId: string): Promise<ProviderMessageRef | null>;
  providerRefOfFolder(account: AuthorizedAccount, folderId: string): Promise<ProviderFolderRef | null>;

  /** Look up an existing message by server (folder, uidValidity, uid). */
  findMessageByProviderUid(
    account: AuthorizedAccount,
    folderId: string,
    uidValidity: number,
    uid: number,
  ): Promise<{ readonly id: string; readonly messageIdHeader: string | null; readonly pinned: boolean } | null>;

  /** Look up an existing message across the account by Message-ID header (for moves and UIDVALIDITY resets). */
  findMessageByHeaderId(
    account: AuthorizedAccount,
    messageIdHeader: string,
  ): Promise<{ readonly id: string; readonly folderId: string; readonly pinned: boolean; readonly fromEmail: string; readonly dateUtc: string } | null>;

  /** All provider UIDs currently stored in this folder. */
  getMailboxUids(account: AuthorizedAccount, folderId: string): Promise<readonly number[]>;

  /** Remove messages by UID in bulk (e.g. server deletions). Returns number of removed messages. */
  removeMessagesByUids(account: AuthorizedAccount, folderId: string, uids: readonly number[]): Promise<number>;

  /** Purge all server-backed messages in a folder (for UIDVALIDITY resets). Keeps local drafts intact. */
  clearFolderMessages(account: AuthorizedAccount, folderId: string): Promise<number>;

  /** Fast-path updates for message flags without rewriting entire message body / recipients / attachments. */
  updateMessageFlagsByUid(
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
  ): Promise<boolean>;
}

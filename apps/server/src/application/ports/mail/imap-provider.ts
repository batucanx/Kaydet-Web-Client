import type { FolderRole } from '@kaydet/domain';
import type { AuthorizedAccount } from '../../context/authorized-account.ts';
import type { ProviderFolderRef, StoredFolder, StoredMessage } from '../repositories/mail-store.ts';

export interface ImapFolderItem {
  readonly path: string;
  readonly delimiter: string;
  readonly name: string;
  readonly role: FolderRole;
  readonly sortOrder: number;
  readonly specialUse: string | null;
  readonly uidValidity: number | null;
  readonly uidNext: number | null;
  readonly highestModSeq: number | null;
}

export interface ImapFetchOptions {
  readonly uids?: readonly number[];
  readonly minUid?: number;
  readonly maxUid?: number;
  readonly limit?: number;
}

export interface ImapMessageFlagsChange {
  readonly uid: number;
  readonly modSeq?: number | null;
  readonly flags: {
    readonly seen: boolean;
    readonly pinned: boolean;
    readonly answered: boolean;
    readonly forwarded: boolean;
    readonly serverDeleted: boolean;
  };
}

export interface ImapProvider {
  /**
   * Tests connectivity, TLS handshake, and authentication against the provider.
   * Throws normalized AppError on failure.
   */
  testConnection(account: AuthorizedAccount): Promise<void>;

  /**
   * Discovers mailboxes from the server, mapping special-use roles and display names.
   */
  listMailboxes(account: AuthorizedAccount): Promise<readonly StoredFolder[]>;

  /**
   * Inspects a specific mailbox to get current UIDVALIDITY, UIDNEXT and HIGHESTMODSEQ.
   */
  inspectMailbox(account: AuthorizedAccount, path: string): Promise<ProviderFolderRef | null>;

  /**
   * Fetches messages from a mailbox using streaming/paged UID ranges,
   * parsing MIME structures, attachments metadata and sanitizing HTML.
   */
  fetchMessages(
    account: AuthorizedAccount,
    folderId: string,
    path: string,
    options?: ImapFetchOptions,
  ): Promise<readonly StoredMessage[]>;

  /**
   * Applies flag updates (e.g. \Seen, \Flagged, \Deleted) or custom keywords to messages.
   */
  updateFlags(
    account: AuthorizedAccount,
    path: string,
    uids: readonly number[],
    operations: {
      add?: readonly string[];
      remove?: readonly string[];
    },
  ): Promise<void>;

  /**
   * Lightweight fetch for flag and modseq updates without downloading message bodies.
   * Supports CONDSTORE changedSince filtering.
   */
  fetchFlags(
    account: AuthorizedAccount,
    path: string,
    options?: {
      readonly uids?: readonly number[];
      readonly changedSince?: number;
    },
  ): Promise<readonly ImapMessageFlagsChange[]>;

  /**
   * Discovers all current message UIDs in a mailbox for deletion reconciliation.
   */
  searchUids(account: AuthorizedAccount, path: string): Promise<readonly number[]>;
}

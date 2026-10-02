import { folderDisplayName, folderLeafName, folderSortOrder, resolveFolderRole } from '@kaydet/domain';
import type { FolderRole } from '@kaydet/domain';
import type { ProviderFolderRef, StoredFolder } from '../../application/ports/repositories/mail-store.ts';

const SPECIAL_USE_MAP: Readonly<Record<string, FolderRole>> = {
  '\\inbox': 'inbox',
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\trash': 'trash',
  '\\junk': 'junk',
  '\\archive': 'archive',
};

/**
 * Maps an IMAP mailbox from the server into a domain StoredFolder representation.
 */
export function mapImapMailboxToStoredFolder(
  folderId: string,
  mailbox: {
    path: string;
    delimiter?: string;
    specialUse?: string | null;
    uidValidity?: number | bigint | null;
    uidNext?: number | bigint | null;
    highestModseq?: number | bigint | null;
  },
): StoredFolder {
  const delimiter = mailbox.delimiter ?? '/';
  const path = mailbox.path;

  let serverRole: FolderRole | undefined;
  if (mailbox.specialUse) {
    serverRole = SPECIAL_USE_MAP[mailbox.specialUse.toLowerCase()];
  }

  const role = resolveFolderRole({
    path,
    delimiter,
    serverRole,
  });

  const leaf = folderLeafName(path, delimiter);
  const name = folderDisplayName(role, leaf);
  const sortOrder = folderSortOrder(role);

  const provider: ProviderFolderRef = {
    path,
    delimiter,
    uidValidity: mailbox.uidValidity != null ? Number(mailbox.uidValidity) : null,
    uidNext: mailbox.uidNext != null ? Number(mailbox.uidNext) : null,
    highestModSeq: mailbox.highestModseq != null ? Number(mailbox.highestModseq) : null,
  };

  return {
    id: folderId,
    name,
    role,
    sortOrder,
    provider,
  };
}

export interface ImapFlagsMapping {
  readonly seen: boolean;
  /** IMAP \Flagged flag */
  readonly pinned: boolean;
  readonly answered: boolean;
  readonly forwarded: boolean;
  readonly draft: boolean;
  readonly serverDeleted: boolean;
  readonly customLabels: readonly string[];
}

/**
 * Maps standard IMAP flags and custom keywords.
 */
export function mapImapFlags(flags: Iterable<string>): ImapFlagsMapping {
  let seen = false;
  let pinned = false;
  let answered = false;
  let forwarded = false;
  let draft = false;
  let serverDeleted = false;
  const customLabels: string[] = [];

  for (const flag of flags) {
    const lower = flag.toLowerCase();
    switch (lower) {
      case '\\seen':
        seen = true;
        break;
      case '\\flagged':
        pinned = true;
        break;
      case '\\answered':
        answered = true;
        break;
      case '$forwarded':
      case '\\forwarded':
        forwarded = true;
        break;
      case '\\draft':
        draft = true;
        break;
      case '\\deleted':
        serverDeleted = true;
        break;
      default:
        if (flag.startsWith('kaydet_')) {
          customLabels.push(flag);
        }
        break;
    }
  }

  return {
    seen,
    pinned,
    answered,
    forwarded,
    draft,
    serverDeleted,
    customLabels,
  };
}

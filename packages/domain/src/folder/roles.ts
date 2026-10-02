/**
 * Folder roles: mapping a server folder to the role Kaydet works with, plus role-level rules.
 *
 * SOURCE: mobile `lib/domain/use_cases/folder_mapping.dart` (`FolderMapping`) and the `SpecialUse` enum
 *         in `mail_models.dart`; the Drafts rule comes from `confirmDelete` in
 *         `lib/ui/core/actions/message_actions.dart`.
 * PURPOSE: Whatever the server calls a folder (`INBOX.Sent`, `Gönderilmiş Öğeler`, `Sent Items`) the app
 *          works with a role. The server's SPECIAL-USE flag (certain) wins; otherwise the folder name is
 *          matched against English + Turkish names. Turkish hosting providers use names that differ per
 *          server (`Gönderilmiş Öğeler`, `Önemsiz`, `Çöp Kutusu`).
 * WEB USAGE: server folder sync (`resolveFolderRole`), sidebar order/labels, delete behaviour, and the
 *            action rules in `actions/`.
 */
import { foldForSearch } from '../turkish/index.ts';

export const FOLDER_ROLES = ['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive', 'custom'] as const;
/** mobile: `SpecialUse`. */
export type FolderRole = (typeof FOLDER_ROLES)[number];

/** English + Turkish folder names in folded form (mobile `_names`). Iteration order matters. */
const NAMES: ReadonlyArray<readonly [FolderRole, readonly string[]]> = [
  ['inbox', ['inbox', 'gelen', 'gelen kutusu', 'gelenkutusu']],
  ['sent', [
    'sent', 'sent items', 'sent messages', 'sentmail', 'sent mail',
    'gonderilmis', 'gonderilmis ogeler', 'gonderilenler', 'giden', 'giden kutusu',
  ]],
  ['drafts', ['drafts', 'draft', 'taslak', 'taslaklar', 'taslak ogeler']],
  ['trash', [
    'trash', 'deleted', 'deleted items', 'deleted messages', 'bin',
    'cop', 'cop kutusu', 'silinmis', 'silinmis ogeler', 'cop kutusu ogeleri',
  ]],
  ['junk', [
    'junk', 'spam', 'bulk mail', 'junk e-mail',
    'istenmeyen', 'istenmeyen posta', 'onemsiz', 'gereksiz',
  ]],
  ['archive', ['archive', 'archives', 'all mail', 'arsiv', 'arsivler']],
];

/** Last path component: `INBOX.Sent` → `Sent`. */
export function folderLeafName(path: string, delimiter: string): string {
  if (delimiter === '') return path;
  const index = path.lastIndexOf(delimiter);
  if (index < 0 || index === path.length - 1) return path;
  return path.slice(index + delimiter.length);
}

/**
 * Role of a server folder. `serverRole` (from SPECIAL-USE/XLIST) always wins when it is not `custom`;
 * `INBOX` is a fixed, case-insensitive name in IMAP.
 */
export function resolveFolderRole(input: {
  path: string;
  delimiter: string;
  serverRole?: FolderRole | null | undefined;
}): FolderRole {
  const { path, delimiter, serverRole } = input;
  if (serverRole != null && serverRole !== 'custom') return serverRole;
  if (path.toUpperCase() === 'INBOX') return 'inbox';

  const leaf = foldForSearch(folderLeafName(path, delimiter)).trim();
  // (An empty delimiter would make `replaceAll` insert a space between every character.)
  const full = foldForSearch(delimiter === '' ? path : path.replaceAll(delimiter, ' ')).trim();

  for (const [role, candidates] of NAMES) {
    if (candidates.includes(leaf)) return role;
  }
  // No exact leaf match: look for the name at the end of a combined path such as `INBOX.Sent Items`.
  for (const [role, candidates] of NAMES) {
    if (candidates.some((c) => full === c || full.endsWith(` ${c}`))) return role;
  }
  return 'custom';
}

/** Sidebar order; Drafts sit right above Trash (mobile `sortOrderFor`). */
export function folderSortOrder(role: FolderRole): number {
  switch (role) {
    case 'inbox': return 0;
    case 'sent': return 10;
    case 'archive': return 20;
    case 'drafts': return 30;
    case 'trash': return 40;
    case 'junk': return 50;
    case 'custom': return 100;
  }
}

/** Turkish name shown for a role; a custom folder shows its own name. */
export function folderDisplayName(role: FolderRole, fallback: string): string {
  switch (role) {
    case 'inbox': return 'Gelen Kutusu';
    case 'sent': return 'Gönderilenler';
    case 'drafts': return 'Taslaklar';
    case 'trash': return 'Çöp Kutusu';
    case 'junk': return 'İstenmeyen';
    case 'archive': return 'Arşiv';
    case 'custom': return fallback;
  }
}

/** System folders cannot be renamed, moved or deleted. */
export function isSystemFolder(role: FolderRole): boolean {
  return role !== 'custom';
}

/** Deleting inside Trash/Junk is permanent (EXPUNGE); elsewhere delete moves to Trash (mobile). */
export function folderDeleteIsPermanent(role: FolderRole): boolean {
  return role === 'trash' || role === 'junk';
}

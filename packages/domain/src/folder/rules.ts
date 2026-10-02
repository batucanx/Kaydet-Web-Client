/**
 * Folder mutation rules (create / rename / move / delete) as pure planners.
 *
 * SOURCE: mobile `lib/data/repositories/folder_repository.dart` (`createFolder`, `renameFolder`,
 *         `moveFolder`, `deleteFolder`) and `MailboxPathHelpers.childPath` in `mail_connection.dart`;
 *         failure wording lives in `api/errors.ts` (mobile `AppFailure`).
 * PURPOSE: The checks that must hold BEFORE anything is sent to the mail server, expressed once. Each
 *          planner returns the resulting server path or the rule that was violated; performing the IMAP
 *          command and persisting the result is the server's job (infrastructure).
 * WEB USAGE: server folder endpoints (`POST/PATCH/DELETE /accounts/:id/folders…`). The browser only needs
 *            the cheap subset (`trimmedFolderName`) for inline feedback; it never sees paths.
 */
import { trLower } from '../turkish/index.ts';
import { folderLeafName, isSystemFolder } from './roles.ts';
import type { FolderRole } from './roles.ts';

/** The path facts of a folder that a planner needs (server-side data). */
export interface FolderPathInfo {
  readonly id: string;
  readonly path: string;
  readonly delimiter: string;
  readonly role: FolderRole;
}

export type FolderRuleViolation =
  | 'invalid_folder_name'
  | 'invalid_folder_move'
  | 'folder_exists'
  | 'system_folder_protected'
  | 'folder_has_children'
  | 'folder_not_found';

export type FolderPlan<T extends object = object> = ({ ok: true } & T) | { ok: false; violation: FolderRuleViolation };

const fail = (violation: FolderRuleViolation): { ok: false; violation: FolderRuleViolation } => ({
  ok: false,
  violation,
});

/** `INBOX` + `Arşiv` → `INBOX.Arşiv` (an empty parent path gives the bare name). */
export function childPath(parent: Pick<FolderPathInfo, 'path' | 'delimiter'>, childName: string): string {
  return parent.path === '' ? childName : `${parent.path}${parent.delimiter}${childName}`;
}

/** Trimmed name when it is usable, else `null` (empty, or contains the hierarchy delimiter). */
export function trimmedFolderName(name: string, delimiter: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return null;
  if (delimiter !== '' && trimmed.includes(delimiter)) return null;
  return trimmed;
}

const pathTaken = (existing: Iterable<string>, path: string, ignore?: string): boolean => {
  const wanted = trLower(path);
  for (const p of existing) if (p !== ignore && trLower(p) === wanted) return true;
  return false;
};

/**
 * Create a folder. `parent` is already resolved by the server (explicit parent, or the namespace default
 * such as Inbox on `INBOX.`-style servers); `delimiter` is that parent's (or the account default, `.`).
 */
export function planCreateFolder(input: {
  name: string;
  parent: FolderPathInfo | null;
  delimiter: string;
  existingPaths: Iterable<string>;
}): FolderPlan<{ path: string; name: string }> {
  const { parent, delimiter } = input;
  if (parent !== null && delimiter === '') return fail('invalid_folder_move');
  const name = trimmedFolderName(input.name, delimiter);
  if (name === null) return fail('invalid_folder_name');
  const path = parent === null ? name : childPath({ path: parent.path, delimiter }, name);
  if (pathTaken(input.existingPaths, path)) return fail('folder_exists');
  return { ok: true, path, name };
}

/** Rename a custom folder in place (the parent stays). */
export function planRenameFolder(input: {
  folder: FolderPathInfo & { readonly name: string };
  newName: string;
  existingPaths: Iterable<string>;
}): FolderPlan<{ path: string; name: string; unchanged: boolean }> {
  const { folder } = input;
  const trimmed = input.newName.trim();
  if (trimmed === '') return fail('invalid_folder_name');
  if (isSystemFolder(folder.role)) return fail('system_folder_protected');
  if (folder.delimiter !== '' && trimmed.includes(folder.delimiter)) return fail('invalid_folder_name');
  if (trimmed === folder.name) return { ok: true, path: folder.path, name: trimmed, unchanged: true };

  const idx = folder.delimiter === '' ? -1 : folder.path.lastIndexOf(folder.delimiter);
  const parentPath = idx <= 0 ? null : folder.path.slice(0, idx);
  const path = parentPath === null ? trimmed : `${parentPath}${folder.delimiter}${trimmed}`;
  if (pathTaken(input.existingPaths, path, folder.path)) return fail('folder_exists');
  return { ok: true, path, name: trimmed, unchanged: false };
}

/** Move a custom folder under `newParent` (`null` = top level). */
export function planMoveFolder(input: {
  folder: FolderPathInfo;
  newParent: FolderPathInfo | null;
  existingPaths: Iterable<string>;
}): FolderPlan<{ path: string; unchanged: boolean }> {
  const { folder, newParent } = input;
  if (isSystemFolder(folder.role)) return fail('system_folder_protected');
  if (newParent?.id === folder.id) return fail('invalid_folder_move');
  if (newParent !== null && newParent.delimiter !== folder.delimiter) return fail('invalid_folder_move');
  // A folder cannot move into its own subtree.
  if (newParent !== null && newParent.path.startsWith(`${folder.path}${folder.delimiter}`)) {
    return fail('invalid_folder_move');
  }
  const leaf = folderLeafName(folder.path, folder.delimiter);
  const path = newParent === null ? leaf : childPath(newParent, leaf);
  if (path === folder.path) return { ok: true, path, unchanged: true };
  if (pathTaken(input.existingPaths, path, folder.path)) return fail('folder_exists');
  return { ok: true, path, unchanged: false };
}

/** Delete a custom folder that has no sub-folders. `otherPaths` are the paths of all OTHER folders. */
export function planDeleteFolder(input: {
  folder: FolderPathInfo;
  otherPaths: Iterable<string>;
}): FolderPlan {
  const { folder } = input;
  if (isSystemFolder(folder.role)) return fail('system_folder_protected');
  const prefix = `${folder.path}${folder.delimiter}`;
  for (const p of input.otherPaths) if (p.startsWith(prefix)) return fail('folder_has_children');
  return { ok: true };
}

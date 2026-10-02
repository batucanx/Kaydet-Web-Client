/**
 * Folder tree: flattens folders + IMAP paths into the depth-first UI tree.
 *
 * SOURCE: mobile `lib/domain/use_cases/folder_mapping.dart` → `buildFolderTree` / `FolderTreeNode`
 *         (tests: `test/folder_tree_test.dart`).
 * PURPOSE: The hierarchy is derived from the real IMAP parent path, never guessed from a name. System
 *          folders are ALWAYS UI roots (so `INBOX.Sent` is not a child of Inbox); custom folders keep their
 *          real parent (`INBOX.Projeler` stays under Inbox). A custom folder whose parent is not present
 *          (`\Noselect` node, not synced yet) becomes a root so it never breaks the tree.
 * WEB USAGE: server side only, where paths are known (paths never reach the browser — the browser gets
 *            `depth`/`parentId`/`hasChildren` in the FolderDTO). The web mock uses it to build its fixture.
 */
import type { FolderRole } from './roles.ts';

/** What the tree needs to know about a folder. `T` keeps the caller's own fields. */
export interface FolderTreeInput {
  readonly id: string;
  readonly accountId: string;
  /** Full server path (`INBOX.Projeler.2026`). */
  readonly path: string;
  readonly delimiter: string;
  readonly role: FolderRole;
  readonly name: string;
  readonly sortOrder: number;
}

export interface FolderTreeNode<T extends FolderTreeInput> {
  readonly folder: T;
  /** 0 = root. Hidden folders (see `include`) do not add a level. */
  readonly depth: number;
  /** Nearest visible ancestor, `null` for roots. */
  readonly parentId: string | null;
  readonly hasChildren: boolean;
}

function parentPathOf(folder: FolderTreeInput): string | null {
  // A system role keeps a folder a UI root regardless of its server path.
  if (folder.role !== 'custom') return null;
  if (folder.delimiter === '') return null;
  const idx = folder.path.lastIndexOf(folder.delimiter);
  if (idx <= 0) return null;
  return folder.path.slice(0, idx);
}

/**
 * Depth-first tree (parent → children → grandchildren), siblings ordered by `sortOrder`, then by lower-cased
 * name, then by path (plain code-unit comparison like mobile — NOT locale collation).
 * Accounts are traversed in first-seen order (ids are opaque, mobile sorted numeric ids).
 */
export function buildFolderTree<T extends FolderTreeInput>(
  folders: readonly T[],
  options: { include?: (folder: T) => boolean } = {},
): Array<FolderTreeNode<T>> {
  if (folders.length === 0) return [];
  const visible = options.include ?? (() => true);

  // IMAP paths are not identities: different accounts reuse the same path.
  const pathsByAccount = new Map<string, Set<string>>();
  for (const f of folders) {
    let set = pathsByAccount.get(f.accountId);
    if (!set) pathsByAccount.set(f.accountId, (set = new Set()));
    set.add(f.path);
  }

  const children = new Map<string, T[]>();
  const childrenKey = (accountId: string, parentPath: string | null) =>
    `${accountId}\u0000${parentPath === null ? '\u0001root' : `p:${parentPath}`}`;
  for (const f of folders) {
    const parentPath = parentPathOf(f);
    const known = parentPath !== null && (pathsByAccount.get(f.accountId)?.has(parentPath) ?? false);
    const key = childrenKey(f.accountId, known ? parentPath : null);
    const list = children.get(key);
    if (list) list.push(f);
    else children.set(key, [f]);
  }

  const lowerName = (s: string) => s.toLowerCase();
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  for (const list of children.values()) {
    list.sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        cmp(lowerName(a.name), lowerName(b.name)) ||
        cmp(a.path, b.path),
    );
  }

  const nodes: Array<Omit<FolderTreeNode<T>, 'hasChildren'>> = [];
  const traverse = (accountId: string, parentPath: string | null, depth: number, parentId: string | null) => {
    for (const f of children.get(childrenKey(accountId, parentPath)) ?? []) {
      const included = visible(f);
      if (included) nodes.push({ folder: f, depth, parentId });
      traverse(accountId, f.path, depth + (included ? 1 : 0), included ? f.id : parentId);
    }
  };
  for (const accountId of pathsByAccount.keys()) traverse(accountId, null, 0, null);

  const parents = new Set(nodes.map((n) => n.parentId).filter((id): id is string => id !== null));
  return nodes.map((n) => ({ ...n, hasChildren: parents.has(n.folder.id) }));
}

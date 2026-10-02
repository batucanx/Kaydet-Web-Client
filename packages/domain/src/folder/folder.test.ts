import { describe, expect, it } from 'vitest';
import {
  buildFolderTree,
  childPath,
  folderDeleteIsPermanent,
  folderDisplayName,
  folderLeafName,
  folderSortOrder,
  isSystemFolder,
  planCreateFolder,
  planDeleteFolder,
  planMoveFolder,
  planRenameFolder,
  resolveFolderRole,
  trimmedFolderName,
  FOLDER_ROLES,
} from './index.ts';
import type { FolderPathInfo, FolderRole, FolderTreeInput } from './index.ts';

const resolve = (path: string, delimiter = '.', serverRole?: FolderRole) =>
  resolveFolderRole({ path, delimiter, serverRole });

describe('resolveFolderRole (mobile folder_mapping_test.dart)', () => {
  it('the server flag wins over the name', () => {
    expect(resolve('INBOX.Garip Ad', '.', 'sent')).toBe('sent');
  });
  it('a server "custom" falls back to name matching', () => {
    expect(resolve('INBOX.Sent', '.', 'custom')).toBe('sent');
  });
  it('INBOX in any case', () => {
    expect(resolve('INBOX')).toBe('inbox');
    expect(resolve('inbox')).toBe('inbox');
    expect(resolve('Inbox')).toBe('inbox');
  });
  it('cPanel style paths', () => {
    expect(resolve('INBOX.Sent')).toBe('sent');
    expect(resolve('INBOX.Drafts')).toBe('drafts');
    expect(resolve('INBOX.Trash')).toBe('trash');
    expect(resolve('INBOX.Junk')).toBe('junk');
    expect(resolve('INBOX.Archive')).toBe('archive');
  });
  it('multi-word names', () => {
    expect(resolve('INBOX.Sent Items')).toBe('sent');
    expect(resolve('INBOX.Deleted Items')).toBe('trash');
  });
  it('slash delimiter', () => {
    expect(resolve('INBOX/Sent', '/')).toBe('sent');
  });
  it('Turkish hosting names', () => {
    expect(resolve('INBOX.Gönderilmiş Öğeler')).toBe('sent');
    expect(resolve('INBOX.Gönderilenler')).toBe('sent');
    expect(resolve('INBOX.Taslaklar')).toBe('drafts');
    expect(resolve('INBOX.Çöp Kutusu')).toBe('trash');
    expect(resolve('INBOX.Önemsiz')).toBe('junk');
    expect(resolve('INBOX.İstenmeyen')).toBe('junk');
    expect(resolve('INBOX.Arşiv')).toBe('archive');
    expect(resolve('INBOX.Silinmiş Öğeler')).toBe('trash');
  });
  it('case differences do not matter', () => {
    expect(resolve('INBOX.TASLAKLAR')).toBe('drafts');
    expect(resolve('INBOX.çöp kutusu')).toBe('trash');
    expect(resolve('INBOX.ÇÖP KUTUSU')).toBe('trash');
  });
  it('unknown folders are custom', () => {
    expect(resolve('INBOX.Müşteriler')).toBe('custom');
    expect(resolve('INBOX.2026 Projeleri')).toBe('custom');
  });
  it('matches a name at the end of a combined path', () => {
    expect(resolve('Company Archive', '/')).toBe('archive');
  });
  it('an empty delimiter does not corrupt matching', () => {
    expect(resolve('Sent', '')).toBe('sent');
    expect(resolve('Projeler', '')).toBe('custom');
  });
});

describe('role rules', () => {
  it('sort order: Inbox first, Drafts right above Trash', () => {
    const orders = FOLDER_ROLES.map(folderSortOrder);
    expect(folderSortOrder('inbox')).toBe(Math.min(...orders));
    expect(folderSortOrder('drafts')).toBeLessThan(folderSortOrder('trash'));
    expect(folderSortOrder('custom')).toBe(Math.max(...orders));
  });
  it('delete is permanent only in Trash and Junk (Drafts are handled by the action rules)', () => {
    expect(folderDeleteIsPermanent('trash')).toBe(true);
    expect(folderDeleteIsPermanent('junk')).toBe(true);
    for (const role of ['inbox', 'archive', 'sent', 'custom'] as const) {
      expect(folderDeleteIsPermanent(role)).toBe(false);
    }
  });
  it('Turkish display names; custom keeps its own name', () => {
    expect(folderDisplayName('inbox', 'x')).toBe('Gelen Kutusu');
    expect(folderDisplayName('sent', 'x')).toBe('Gönderilenler');
    expect(folderDisplayName('junk', 'x')).toBe('İstenmeyen');
    expect(folderDisplayName('archive', 'x')).toBe('Arşiv');
    expect(folderDisplayName('custom', 'Müşteriler')).toBe('Müşteriler');
  });
  it('only custom folders are user-editable', () => {
    expect(isSystemFolder('inbox')).toBe(true);
    expect(isSystemFolder('custom')).toBe(false);
  });
  it('leaf name', () => {
    expect(folderLeafName('INBOX.Sent', '.')).toBe('Sent');
    expect(folderLeafName('INBOX/Alt/Klasör', '/')).toBe('Klasör');
    expect(folderLeafName('INBOX', '.')).toBe('INBOX');
    expect(folderLeafName('A.', '.')).toBe('A.');
    expect(folderLeafName('A.B', '')).toBe('A.B');
  });
});

const node = (
  id: string,
  path: string,
  name: string,
  role: FolderRole = 'custom',
  extra: Partial<FolderTreeInput> = {},
): FolderTreeInput => ({
  id,
  accountId: 'a1',
  path,
  delimiter: '/',
  role,
  name,
  sortOrder: folderSortOrder(role),
  ...extra,
});
const outline = (nodes: ReturnType<typeof buildFolderTree>) => nodes.map((n) => `${n.folder.name}:${n.depth}`);

describe('buildFolderTree (mobile folder_tree_test.dart)', () => {
  it('builds a real parent/child tree from delimiters, ordered by name within a level', () => {
    const tree = buildFolderTree([
      node('1', 'Müşteriler', 'Müşteriler'),
      node('2', 'Müşteriler/XYZ', 'XYZ'),
      node('3', 'Müşteriler/ABC', 'ABC'),
      node('4', 'Müşteriler/ABC/Sözleşmeler', 'Sözleşmeler'),
    ]);
    expect(outline(tree)).toEqual(['Müşteriler:0', 'ABC:1', 'Sözleşmeler:2', 'XYZ:1']);
    expect(tree.map((n) => n.parentId)).toEqual([null, '1', '3', '1']);
    expect(tree.map((n) => n.hasChildren)).toEqual([true, true, false, false]);
  });

  it('system folders are UI roots while a custom folder under INBOX keeps its parent', () => {
    const d = { delimiter: '.' };
    const tree = buildFolderTree([
      node('i', 'INBOX', 'Gelen Kutusu', 'inbox', d),
      node('s', 'INBOX.Sent', 'Gönderilenler', 'sent', d),
      node('dr', 'INBOX.Drafts', 'Taslaklar', 'drafts', d),
      node('ar', 'INBOX.Archive', 'Arşiv', 'archive', d),
      node('p', 'INBOX.Projeler', 'Projeler', 'custom', { ...d, sortOrder: 100 }),
      node('p26', 'INBOX.Projeler.2026', '2026', 'custom', { ...d, sortOrder: 100 }),
    ]);
    expect(outline(tree)).toEqual([
      'Gelen Kutusu:0',
      'Projeler:1',
      '2026:2',
      'Gönderilenler:0',
      'Arşiv:0',
      'Taslaklar:0',
    ]);
  });

  it('a custom folder under a system folder path stays below it', () => {
    const d = { delimiter: '.' };
    const tree = buildFolderTree([
      node('i', 'INBOX', 'Gelen Kutusu', 'inbox', d),
      node('s', 'INBOX.Sent', 'Gönderilenler', 'sent', d),
      node('o', 'INBOX.Sent.Özel', 'Özel', 'custom', d),
    ]);
    expect(outline(tree)).toEqual(['Gelen Kutusu:0', 'Gönderilenler:0', 'Özel:1']);
  });

  it('the same remote path in different accounts is never linked', () => {
    const tree = buildFolderTree([
      node('1', 'Shared', 'Shared'),
      node('2', 'Shared/Child', 'Child', 'custom', { accountId: 'a2' }),
    ]);
    const child = tree.find((n) => n.folder.name === 'Child');
    expect(child?.depth).toBe(0);
    expect(child?.parentId).toBeNull();
  });

  it('hides a non-selectable container without breaking the subtree relation', () => {
    const tree = buildFolderTree(
      [
        node('r', 'Root', 'Root'),
        node('c', 'Root/Container', 'Container'),
        node('v', 'Root/Container/Visible', 'Visible'),
      ],
      { include: (f) => f.id !== 'c' },
    );
    expect(outline(tree)).toEqual(['Root:0', 'Visible:1']);
    // The visible child hangs off the nearest VISIBLE ancestor.
    expect(tree[1]?.parentId).toBe('r');
    expect(tree[0]?.hasChildren).toBe(true);
  });

  it('an orphan (parent missing locally) becomes a root', () => {
    const tree = buildFolderTree([node('x', 'Missing/Child', 'Child')]);
    expect(outline(tree)).toEqual(['Child:0']);
  });

  it('is empty for no folders and sorts by lower-cased name then path', () => {
    expect(buildFolderTree([])).toEqual([]);
    const tree = buildFolderTree([node('b', 'b', 'beta'), node('a', 'A', 'Alfa'), node('c', 'Z', 'alfa')]);
    // 'alfa' == 'alfa' → tie broken by path ('A' < 'Z').
    expect(tree.map((n) => n.folder.id)).toEqual(['a', 'c', 'b']);
  });

  it('preserves the caller\'s extra fields', () => {
    const tree = buildFolderTree([{ ...node('1', 'X', 'X'), unread: 7 }]);
    expect(tree[0]?.folder.unread).toBe(7);
  });
});

const info = (id: string, path: string, role: FolderRole = 'custom', delimiter = '/'): FolderPathInfo => ({
  id,
  path,
  delimiter,
  role,
});

describe('folder mutation rules (mobile folder_repository.dart)', () => {
  it('trimmedFolderName rejects empty and delimiter-containing names', () => {
    expect(trimmedFolderName('  Fatura  ', '/')).toBe('Fatura');
    expect(trimmedFolderName('   ', '/')).toBeNull();
    expect(trimmedFolderName('A/B', '/')).toBeNull();
    expect(trimmedFolderName('A.B', '/')).toBe('A.B');
    expect(trimmedFolderName('A/B', '')).toBe('A/B');
  });

  it('childPath', () => {
    expect(childPath({ path: 'INBOX', delimiter: '.' }, 'Arşiv')).toBe('INBOX.Arşiv');
    expect(childPath({ path: '', delimiter: '.' }, 'Arşiv')).toBe('Arşiv');
  });

  describe('create', () => {
    const create = (name: string, parent: FolderPathInfo | null, existing: string[] = []) =>
      planCreateFolder({ name, parent, delimiter: parent?.delimiter ?? '/', existingPaths: existing });

    it('builds the path under a parent or at the top level', () => {
      expect(create('Yeni', info('p', 'Proje'))).toEqual({ ok: true, path: 'Proje/Yeni', name: 'Yeni' });
      expect(create(' Yeni ', null)).toEqual({ ok: true, path: 'Yeni', name: 'Yeni' });
    });
    it('invalid name', () => {
      expect(create('', null)).toEqual({ ok: false, violation: 'invalid_folder_name' });
      expect(create('A/B', null)).toEqual({ ok: false, violation: 'invalid_folder_name' });
    });
    it('duplicate path, compared Turkish-case-insensitively', () => {
      expect(create('Fatura', null, ['fatura'])).toEqual({ ok: false, violation: 'folder_exists' });
      expect(create('IŞIK', null, ['ışık'])).toEqual({ ok: false, violation: 'folder_exists' });
      // Default lower-casing would make 'I' collide with 'i'; the Turkish rule keeps them apart.
      expect(create('Iş', null, ['iş']).ok).toBe(true);
    });
    it('a parent without a delimiter cannot have children', () => {
      expect(planCreateFolder({ name: 'X', parent: info('p', 'P', 'custom', ''), delimiter: '', existingPaths: [] })).toEqual({
        ok: false,
        violation: 'invalid_folder_move',
      });
    });
  });

  describe('rename', () => {
    const rename = (folder: FolderPathInfo & { name: string }, newName: string, existing: string[] = []) =>
      planRenameFolder({ folder, newName, existingPaths: existing });
    const proj = { ...info('f', 'Proje/Eski'), name: 'Eski' };

    it('renames in place under the same parent', () => {
      expect(rename(proj, 'Yeni')).toEqual({ ok: true, path: 'Proje/Yeni', name: 'Yeni', unchanged: false });
      expect(rename({ ...info('f', 'Eski'), name: 'Eski' }, 'Yeni')).toEqual({
        ok: true,
        path: 'Yeni',
        name: 'Yeni',
        unchanged: false,
      });
    });
    it('same name is a no-op', () => {
      expect(rename(proj, ' Eski ')).toMatchObject({ ok: true, unchanged: true, path: 'Proje/Eski' });
    });
    it('rules', () => {
      expect(rename(proj, '  ')).toEqual({ ok: false, violation: 'invalid_folder_name' });
      expect(rename(proj, 'A/B')).toEqual({ ok: false, violation: 'invalid_folder_name' });
      expect(rename(proj, 'Var', ['Proje/var'])).toEqual({ ok: false, violation: 'folder_exists' });
      expect(rename({ ...info('i', 'INBOX', 'inbox'), name: 'Gelen Kutusu' }, 'X')).toEqual({
        ok: false,
        violation: 'system_folder_protected',
      });
    });
    it('renaming to a case variant of itself is not a duplicate of itself', () => {
      expect(rename(proj, 'eski', ['Proje/Eski'])).toMatchObject({ ok: true, path: 'Proje/eski' });
    });
  });

  describe('move', () => {
    const move = (folder: FolderPathInfo, newParent: FolderPathInfo | null, existing: string[] = []) =>
      planMoveFolder({ folder, newParent, existingPaths: existing });
    const f = info('f', 'A/Klasör');

    it('moves under another parent or to the top level', () => {
      expect(move(f, info('b', 'B'))).toEqual({ ok: true, path: 'B/Klasör', unchanged: false });
      expect(move(f, null)).toEqual({ ok: true, path: 'Klasör', unchanged: false });
    });
    it('moving to where it already is is a no-op', () => {
      expect(move(f, info('a', 'A'))).toMatchObject({ ok: true, unchanged: true });
    });
    it('cannot move into itself or its own subtree', () => {
      expect(move(f, f)).toEqual({ ok: false, violation: 'invalid_folder_move' });
      expect(move(f, info('c', 'A/Klasör/Alt'))).toEqual({ ok: false, violation: 'invalid_folder_move' });
    });
    it('a sibling whose name merely starts with the same text is not "inside"', () => {
      expect(move(f, info('s', 'A/Klasör2'))).toMatchObject({ ok: true, path: 'A/Klasör2/Klasör' });
    });
    it('rejects delimiter mismatch, system folders and duplicates', () => {
      expect(move(f, info('b', 'B', 'custom', '.'))).toEqual({ ok: false, violation: 'invalid_folder_move' });
      expect(move(info('i', 'INBOX', 'inbox'), null)).toEqual({ ok: false, violation: 'system_folder_protected' });
      expect(move(f, info('b', 'B'), ['b/klasör'])).toEqual({ ok: false, violation: 'folder_exists' });
    });
  });

  describe('delete', () => {
    it('allows a leaf custom folder', () => {
      expect(planDeleteFolder({ folder: info('f', 'A'), otherPaths: ['B', 'AB/x'] })).toEqual({ ok: true });
    });
    it('rejects system folders and folders with children', () => {
      expect(planDeleteFolder({ folder: info('i', 'INBOX', 'inbox'), otherPaths: [] })).toEqual({
        ok: false,
        violation: 'system_folder_protected',
      });
      expect(planDeleteFolder({ folder: info('f', 'A'), otherPaths: ['A/Alt'] })).toEqual({
        ok: false,
        violation: 'folder_has_children',
      });
    });
  });
});

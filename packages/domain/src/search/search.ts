/**
 * Search normalisation and search filters.
 *
 * SOURCE: mobile `lib/data/database/app_database.dart` → `buildFtsQuery` (tokenisation) and
 *         `_messageFilterSql` (filter semantics); `lib/domain/models/search_filters.dart`
 *         (`SearchFilters`, `SearchFolder`; tests: `test/search_filters_test.dart`).
 * PURPOSE: The query is folded with the same function as the index (`foldForSearch`) and split into
 *          letter/digit tokens — punctuation must never reach the search engine as syntax. The engine itself
 *          (mobile: SQLite FTS5 prefix match `"tok"*`) is infrastructure; only the tokenisation and the
 *          filter rules are domain, so any backend gives the same results.
 *          Filter rules: `\Deleted`-flagged mail never appears; "Tüm Klasörler" excludes Trash unless
 *          `includeDeleted`; a specific folder is matched by ROLE (all accounts' Inbox merge into one option)
 *          and, for custom folders, by exact NAME (same-named folders of different accounts merge).
 * WEB USAGE: `GET /search` query handling on the server; the search UI's filter badge (`searchFilterCount`).
 */
import { foldForSearch } from '../turkish/index.ts';
import type { FolderRole } from '../folder/index.ts';

/** Folded tokens of a user query; `[]` when nothing searchable remains (an empty query finds nothing). */
export function tokenizeSearchQuery(raw: string): string[] {
  const folded = foldForSearch(raw).trim();
  if (folded === '') return [];
  return folded.split(/[^\p{L}\p{N}]+/u).filter((t) => t !== '');
}

/**
 * Folder scope of a search: a standard role, or a user-created folder by name. Roles rather than folder ids
 * because a search may span accounts and each account has its own Inbox id.
 */
export type SearchFolder =
  | { readonly role: Exclude<FolderRole, 'custom'>; readonly name?: undefined }
  | { readonly role: 'custom'; readonly name: string };

/** The search option for a folder row (mobile `SearchFolder.of`). */
export function searchFolderOf(role: FolderRole, name: string): SearchFolder {
  return role === 'custom' ? { role: 'custom', name } : { role };
}

export function sameSearchFolder(a: SearchFolder | null, b: SearchFolder | null): boolean {
  if (a === null || b === null) return a === b;
  return a.role === b.role && a.name === b.name;
}

export interface SearchFilters {
  readonly attachmentsOnly: boolean;
  /** Include Trash in an "all folders" search. No effect once a specific folder is chosen. */
  readonly includeDeleted: boolean;
  /** `null` = all folders. */
  readonly folder: SearchFolder | null;
}

export const EMPTY_SEARCH_FILTERS: SearchFilters = { attachmentsOnly: false, includeDeleted: false, folder: null };

/** Number of filters that actually take effect (the badge on the filter button). */
export function searchFilterCount(f: SearchFilters): number {
  return (f.attachmentsOnly ? 1 : 0) + (f.includeDeleted && f.folder === null ? 1 : 0) + (f.folder !== null ? 1 : 0);
}

export const isSearchFilterActive = (f: SearchFilters): boolean => searchFilterCount(f) > 0;

/** Would this message be a search hit under the filters (query matching aside)? */
export function matchesSearchFilters(
  message: {
    readonly hasAttachments: boolean;
    /** Server `\Deleted` flag (NOT "in Trash"). */
    readonly flaggedDeleted: boolean;
    readonly folderRole: FolderRole;
    readonly folderName: string;
  },
  filters: SearchFilters,
): boolean {
  if (message.flaggedDeleted) return false;
  if (filters.attachmentsOnly && !message.hasAttachments) return false;
  const { folder } = filters;
  if (folder === null) return filters.includeDeleted || message.folderRole !== 'trash';
  if (message.folderRole !== folder.role) return false;
  return folder.name === undefined || message.folderName === folder.name;
}

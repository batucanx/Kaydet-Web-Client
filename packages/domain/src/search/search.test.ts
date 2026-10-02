import { describe, expect, it } from 'vitest';
import {
  EMPTY_SEARCH_FILTERS,
  isSearchFilterActive,
  matchesSearchFilters,
  sameSearchFolder,
  searchFilterCount,
  searchFolderOf,
  tokenizeSearchQuery,
} from './search.ts';
import type { SearchFilters } from './search.ts';

describe('tokenizeSearchQuery (mobile buildFtsQuery)', () => {
  it('folds Turkish letters and lower-cases', () => {
    expect(tokenizeSearchQuery('Görüşme ŞAHAN')).toEqual(['gorusme', 'sahan']);
    expect(tokenizeSearchQuery('IŞIK')).toEqual(['isik']);
  });
  it('splits on any non letter/digit, so operator characters are inert', () => {
    expect(tokenizeSearchQuery('"a" OR -b* (c)')).toEqual(['a', 'or', 'b', 'c']);
    expect(tokenizeSearchQuery('fatura-2026/04')).toEqual(['fatura', '2026', '04']);
  });
  it('empty/punctuation-only queries have no tokens', () => {
    expect(tokenizeSearchQuery('')).toEqual([]);
    expect(tokenizeSearchQuery('   ')).toEqual([]);
    expect(tokenizeSearchQuery('!!! ---')).toEqual([]);
  });
  it('index side and query side agree', () => {
    expect(tokenizeSearchQuery('TOPLANTI')).toEqual(tokenizeSearchQuery('Toplantı'));
  });
});

describe('SearchFilters (mobile search_filters_test.dart)', () => {
  const f = (o: Partial<SearchFilters>): SearchFilters => ({ ...EMPTY_SEARCH_FILTERS, ...o });

  it('default is inactive', () => {
    expect(isSearchFilterActive(EMPTY_SEARCH_FILTERS)).toBe(false);
    expect(searchFilterCount(EMPTY_SEARCH_FILTERS)).toBe(0);
  });

  it('counts only filters that take effect', () => {
    expect(searchFilterCount(f({ attachmentsOnly: true }))).toBe(1);
    expect(searchFilterCount(f({ includeDeleted: true }))).toBe(1);
    expect(searchFilterCount(f({ folder: { role: 'inbox' } }))).toBe(1);
    // includeDeleted is moot once a specific folder is chosen.
    expect(searchFilterCount(f({ includeDeleted: true, folder: { role: 'inbox' } }))).toBe(1);
    expect(searchFilterCount(f({ attachmentsOnly: true, includeDeleted: true }))).toBe(2);
  });

  it('searchFolderOf: custom by name, standard by role only', () => {
    expect(searchFolderOf('custom', 'Work')).toEqual({ role: 'custom', name: 'Work' });
    expect(searchFolderOf('inbox', 'Gelen Kutusu')).toEqual({ role: 'inbox' });
  });

  it('same role merges regardless of folder names; custom folders differ by name', () => {
    expect(sameSearchFolder(searchFolderOf('sent', 'Sent Items'), searchFolderOf('sent', 'Gönderilenler'))).toBe(true);
    expect(sameSearchFolder(searchFolderOf('custom', 'Work'), searchFolderOf('custom', 'Work'))).toBe(true);
    expect(sameSearchFolder(searchFolderOf('custom', 'Work'), searchFolderOf('custom', 'School'))).toBe(false);
    expect(sameSearchFolder(null, null)).toBe(true);
    expect(sameSearchFolder(null, searchFolderOf('inbox', ''))).toBe(false);
  });
});

describe('matchesSearchFilters (mobile _messageFilterSql)', () => {
  const msg = (o: Partial<Parameters<typeof matchesSearchFilters>[0]> = {}) => ({
    hasAttachments: false,
    flaggedDeleted: false,
    folderRole: 'inbox' as const,
    folderName: 'Gelen Kutusu',
    ...o,
  });
  const f = (o: Partial<SearchFilters>): SearchFilters => ({ ...EMPTY_SEARCH_FILTERS, ...o });

  it('\\Deleted-flagged mail is never a hit', () => {
    expect(matchesSearchFilters(msg({ flaggedDeleted: true }), f({ includeDeleted: true }))).toBe(false);
  });
  it('all folders excludes Trash unless includeDeleted', () => {
    expect(matchesSearchFilters(msg({ folderRole: 'trash' }), f({}))).toBe(false);
    expect(matchesSearchFilters(msg({ folderRole: 'trash' }), f({ includeDeleted: true }))).toBe(true);
    expect(matchesSearchFilters(msg({ folderRole: 'junk' }), f({}))).toBe(true);
  });
  it('a specific folder is searched even when it is Trash', () => {
    expect(matchesSearchFilters(msg({ folderRole: 'trash' }), f({ folder: { role: 'trash' } }))).toBe(true);
  });
  it('folder matches by role; custom folders also by exact name', () => {
    expect(matchesSearchFilters(msg(), f({ folder: { role: 'inbox' } }))).toBe(true);
    expect(matchesSearchFilters(msg({ folderRole: 'sent' }), f({ folder: { role: 'inbox' } }))).toBe(false);
    const work = f({ folder: { role: 'custom', name: 'Work' } });
    expect(matchesSearchFilters(msg({ folderRole: 'custom', folderName: 'Work' }), work)).toBe(true);
    expect(matchesSearchFilters(msg({ folderRole: 'custom', folderName: 'Other' }), work)).toBe(false);
  });
  it('attachments only', () => {
    expect(matchesSearchFilters(msg(), f({ attachmentsOnly: true }))).toBe(false);
    expect(matchesSearchFilters(msg({ hasAttachments: true }), f({ attachmentsOnly: true }))).toBe(true);
  });
});

import { Check, ChevronDown, Folder, Paperclip, Trash2, X } from 'lucide-react';
import type { FolderView } from '../../data/types';
import type { SearchAccountScope, SearchFilters, SearchFolder } from '@kaydet/domain';
import {
  isSearchFilterActive,
  searchFilterCount,
} from '@kaydet/domain';
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from '../../ui/Menu';
import styles from './SearchFiltersBar.module.css';

interface SearchFiltersBarProps {
  accountsScope: SearchAccountScope['kind'];
  onScopeChange: (scope: SearchAccountScope['kind']) => void;
  filters: SearchFilters;
  onFilterChange: (patch: Partial<SearchFilters>) => void;
  onClearFilters: () => void;
  folders: FolderView[];
  showAccountToggle?: boolean;
}

export function SearchFiltersBar({
  accountsScope,
  onScopeChange,
  filters,
  onFilterChange,
  onClearFilters,
  folders,
  showAccountToggle = true,
}: SearchFiltersBarProps) {
  const activeCount = searchFilterCount(filters);
  const hasActiveFilters = isSearchFilterActive(filters);

  // Folder label computation
  const getFolderLabel = (sf: SearchFolder | null): string => {
    if (!sf) return 'Tüm Klasörler';
    if (sf.role === 'custom') return sf.name;
    const match = folders.find((f) => f.role === sf.role);
    return match ? match.name : sf.role;
  };

  const currentFolderLabel = getFolderLabel(filters.folder);
  const isCustomFolderSelected = filters.folder !== null;

  return (
    <div className={styles.bar} role="toolbar" aria-label="Arama filtreleri">
      <div className={styles.leftGroup}>
        {showAccountToggle && (
          <div className={styles.accountScope} role="radiogroup" aria-label="Arama kapsamı">
            <button
              type="button"
              className={`${styles.scopeBtn} ${accountsScope === 'account' ? styles.scopeBtnActive : ''}`}
              role="radio"
              aria-checked={accountsScope === 'account'}
              onClick={() => onScopeChange('account')}
            >
              Bu hesap
            </button>
            <button
              type="button"
              className={`${styles.scopeBtn} ${accountsScope === 'all' ? styles.scopeBtnActive : ''}`}
              role="radio"
              aria-checked={accountsScope === 'all'}
              onClick={() => onScopeChange('all')}
            >
              Tüm hesaplar
            </button>
          </div>
        )}

        <div className={styles.chips}>
          {/* Ekli olanlar */}
          <button
            type="button"
            className={`${styles.chip} ${filters.attachmentsOnly ? styles.chipActive : ''}`}
            aria-pressed={filters.attachmentsOnly}
            onClick={() => onFilterChange({ attachmentsOnly: !filters.attachmentsOnly })}
          >
            {filters.attachmentsOnly ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <Paperclip size={14} aria-hidden="true" />
            )}
            <span>Ekli olanlar</span>
          </button>

          {/* Klasör Dropdown */}
          <Menu>
            <MenuTrigger asChild>
              <button
                type="button"
                className={`${styles.chip} ${isCustomFolderSelected ? styles.chipActive : ''}`}
                aria-haspopup="menu"
              >
                <Folder size={14} aria-hidden="true" />
                <span>{currentFolderLabel}</span>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            </MenuTrigger>
            <MenuContent>
              <MenuRadioGroup
                value={
                  filters.folder === null
                    ? '__all__'
                    : filters.folder.role === 'custom'
                      ? `custom:${filters.folder.name}`
                      : filters.folder.role
                }
                onValueChange={(val) => {
                  if (val === '__all__') {
                    onFilterChange({ folder: null });
                  } else if (val.startsWith('custom:')) {
                    const name = val.slice(7);
                    onFilterChange({ folder: { role: 'custom', name } });
                  } else {
                    onFilterChange({ folder: { role: val as Exclude<SearchFolder['role'], 'custom'> } });
                  }
                }}
              >
                <MenuRadioItem value="__all__">Tüm Klasörler</MenuRadioItem>
                {folders.map((f) => {
                  const val = f.role === 'custom' ? `custom:${f.name}` : f.role;
                  return (
                    <MenuRadioItem key={f.id} value={val}>
                      {f.name}
                    </MenuRadioItem>
                  );
                })}
              </MenuRadioGroup>
            </MenuContent>
          </Menu>

          {/* Çöp kutusu dahil (Tüm klasörler seçiliyken anlamlıdır) */}
          {filters.folder === null && (
            <button
              type="button"
              className={`${styles.chip} ${filters.includeDeleted ? styles.chipActive : ''}`}
              aria-pressed={filters.includeDeleted}
              onClick={() => onFilterChange({ includeDeleted: !filters.includeDeleted })}
              title="Çöp kutusundaki iletileri aramaya dahil et"
            >
              {filters.includeDeleted ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Trash2 size={14} aria-hidden="true" />
              )}
              <span>Çöp Kutusu dahil</span>
            </button>
          )}

          {/* Aktif Filtre Sayısı Rozeti */}
          {activeCount > 0 && (
            <span className={styles.badge} aria-label={`${activeCount} aktif filtre`}>
              {activeCount}
            </span>
          )}
        </div>
      </div>

      {hasActiveFilters && (
        <button
          type="button"
          className={styles.clearBtn}
          onClick={onClearFilters}
          aria-label="Filtreleri temizle"
        >
          <X size={14} aria-hidden="true" />
          <span>Filtreleri temizle</span>
        </button>
      )}
    </div>
  );
}

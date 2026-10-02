import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Search as SearchIcon, ServerCrash } from 'lucide-react';
import { useAccounts, useFolders } from '../../data/MailDataContext';
import { isSearchFilterActive } from '@kaydet/domain';
import { useNow } from '../../lib/useNow';
import { useShellMode } from '../../shell/useShellMode';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { IconButton } from '../../ui/IconButton';
import { MailReader } from '../mail-reader/MailReader';
import { MailListSkeleton } from '../mail-list/MailListSkeleton';
import { SearchBar } from '../../shell/SearchBar';
import { SearchFiltersBar } from './SearchFiltersBar';
import { SearchResultRow } from './SearchResultRow';
import { useSearch } from './useSearch';
import styles from './SearchPage.module.css';

export function SearchPage() {
  const { accountId = '', '*': rest = '' } = useParams();
  const activeId = /^m\/(.+)$/.exec(rest)?.[1];
  return <SearchView key={accountId} accountId={accountId} activeId={activeId} />;
}

interface SearchViewProps {
  accountId: string;
  activeId: string | undefined;
}

function SearchView({ accountId, activeId }: SearchViewProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const mode = useShellMode();
  const isMobile = mode === 'mobile';
  const now = useNow();

  const accountsQ = useAccounts();
  const foldersQ = useFolders(accountId);

  const {
    query,
    accountsScope,
    filters,
    results,
    status,
    errorMessage,
    hasMore,
    isLoadingMore,
    loadMore,
    setQuery,
    setScope,
    setFilters,
    clearFilters,
    togglePin,
    toggleSeen,
    deleteMessage,
    retry,
  } = useSearch({ accountId });

  const [selection, setSelection] = useState<Set<string>>(new Set());

  const folders = foldersQ.status === 'ready' ? foldersQ.data : [];
  const accounts = accountsQ.status === 'ready' ? accountsQ.data : [];
  const hasMultipleAccounts = accounts.length > 1;

  const handleCloseReader = () => {
    navigate(`/a/${accountId}/search${location.search}`);
  };

  const handleExitSearch = () => {
    navigate(`/a/${accountId}`);
  };

  const handleToggleSelect = (id: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Full-screen reader on mobile
  if (isMobile && activeId) {
    return (
      <MailReader
        accountId={accountId}
        messageId={activeId}
        onBack={handleCloseReader}
        showBack={true}
        folderName="Arama"
      />
    );
  }

  const renderContent = () => {
    if (status === 'loading') {
      return <MailListSkeleton />;
    }

    if (status === 'error') {
      return (
        <EmptyState
          role="alert"
          icon={ServerCrash}
          title="Arama yapılamadı"
          description={errorMessage ?? 'Lütfen bağlantınızı kontrol edin.'}
          action={<Button onClick={retry}>Tekrar dene</Button>}
        />
      );
    }

    if (status === 'idle') {
      return (
        <EmptyState
          icon={SearchIcon}
          title="Arama yapın"
          description="E-postalarınızda konu, gönderen veya içerik aramak için bir arama terimi yazın."
        />
      );
    }

    if (status === 'ready' && results.length === 0) {
      return (
        <EmptyState
          icon={SearchIcon}
          title="Sonuç bulunamadı"
          description="Aramanızla eşleşen ileti bulunamadı. Farklı anahtar sözcükler deneyin veya filtreleri temizleyin."
          action={
            isSearchFilterActive(filters) ? (
              <Button onClick={clearFilters}>Filtreleri temizle</Button>
            ) : undefined
          }
        />
      );
    }

    return (
      <div className={styles.listContent}>
        {results.map((result) => {
          const m = result.message;
          const href = m.draft
            ? `/a/${accountId}/compose/${m.draftId ?? m.id}`
            : `/a/${accountId}/search/m/${m.id}${location.search}`;

          return (
            <SearchResultRow
              key={m.id}
              result={result}
              selected={selection.has(m.id)}
              active={activeId === m.id}
              now={now}
              href={href}
              onToggleSelect={handleToggleSelect}
              onTogglePin={togglePin}
              onToggleSeen={toggleSeen}
              onDelete={deleteMessage}
            />
          );
        })}

        {hasMore && (
          <div className={styles.loadMoreRow}>
            <button
              type="button"
              className={styles.loadMoreBtn}
              onClick={loadMore}
              disabled={isLoadingMore}
            >
              {isLoadingMore ? 'Yükleniyor…' : 'Daha fazla sonuç yükle'}
            </button>
          </div>
        )}
      </div>
    );
  };

  const hasReader = Boolean(activeId);

  return (
    <div className={`${styles.page} ${hasReader ? styles.hasReader : ''}`}>
      <section className={styles.listPane} aria-label="Arama sonuçları">
        <div className={styles.header}>
          <div className={styles.searchRow}>
            <IconButton
              icon={ArrowLeft}
              label="Aramadan çık"
              className={styles.backBtn}
              onClick={handleExitSearch}
            />
            <div className={styles.inputWrapper}>
              <SearchBar
                initialValue={query}
                showShortcutHint={false}
                onSubmit={(q) => setQuery(q)}
                onChange={(q) => setQuery(q)}
                onClear={() => setQuery('')}
              />
            </div>
          </div>

          <SearchFiltersBar
            accountsScope={accountsScope}
            onScopeChange={setScope}
            filters={filters}
            onFilterChange={setFilters}
            onClearFilters={clearFilters}
            folders={folders}
            showAccountToggle={hasMultipleAccounts}
          />

          {status === 'ready' && results.length > 0 && (
            <div className={styles.summaryBar}>
              <span className={styles.summaryCount}>
                {results.length} sonuç {hasMore ? '(daha fazla var)' : ''}
              </span>
              <span>{accountsScope === 'all' ? 'Tüm hesaplar' : 'Bu hesap'}</span>
            </div>
          )}
        </div>

        {renderContent()}
      </section>

      {hasReader && (
        <section className={styles.readerPane} aria-label="İleti okuyucu">
          <MailReader
            accountId={accountId}
            messageId={activeId!}
            onBack={handleCloseReader}
            showBack={false}
            folderName="Arama"
          />
        </section>
      )}
    </div>
  );
}

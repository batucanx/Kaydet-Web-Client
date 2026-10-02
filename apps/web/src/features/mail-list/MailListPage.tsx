import { Inbox, Search as SearchIcon, ServerCrash } from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useFolders, useLabels, useMessages, usePinnedMessages } from '../../data/MailDataContext';
import { PINNED_FOLDER, isFilterActive } from '../../data/types';
import type { FolderView, LabelView, MessageSummary } from '../../data/types';
import { useEvent } from '../../lib/useEvent';
import { useNow } from '../../lib/useNow';
import { useShellMode } from '../../shell/useShellMode';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { MailReader } from '../mail-reader/MailReader';
import { availableActions } from './actions';
import type { ActionId, ListContext } from './actions';
import { FilterBar } from './FilterBar';
import { buildListItems, visibleMessageIds } from './listItems';
import { MailList } from './MailList';
import { MailListSkeleton } from './MailListSkeleton';
import { MailToolbar } from './MailToolbar';
import { EMPTY_SELECTION, selectionReducer } from './selection';
import { useMailFilter } from './useMailFilter';
import { useMailListActions } from './useMailListActions';
import styles from './MailListPage.module.css';

const NO_LABELS: LabelView[] = [];
const NO_FOLDERS: FolderView[] = [];

/**
 * Route: `/a/:accountId/f/:folderRef[/m/:messageId]`. Split so that the inner view is keyed by
 * account + folder: selection and local UI state reset on navigation without effects.
 */
export function MailListPage() {
  const { accountId = '', folderRef = '', '*': rest = '' } = useParams();
  const messageId = /^m\/(.+)$/.exec(rest)?.[1];
  return <MailListView key={`${accountId}/${folderRef}`} accountId={accountId} folderRef={folderRef} activeId={messageId} />;
}

interface ViewProps {
  accountId: string;
  folderRef: string;
  activeId: string | undefined;
}

function MailListView({ accountId, folderRef, activeId }: ViewProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const mode = useShellMode();
  const isMobile = mode === 'mobile';
  const now = useNow();
  const { filter, update, clear } = useMailFilter();

  const foldersQ = useFolders(accountId);
  const labelsQ = useLabels(accountId);
  const pinnedAll = usePinnedMessages(accountId);
  const messagesQ = useMessages({ accountId, folder: folderRef, filter });

  const folders = foldersQ.status === 'ready' ? foldersQ.data : NO_FOLDERS;
  const labels = labelsQ.status === 'ready' ? labelsQ.data : NO_LABELS;
  const isPinnedView = folderRef === PINNED_FOLDER;
  const folder = folders.find((f) => f.id === folderRef);
  const ctx: ListContext = isPinnedView ? 'pinned' : (folder?.role ?? 'custom');
  const title = isPinnedView ? 'Sabitlenenler' : (folder?.name ?? '');

  const [selection, dispatch] = useReducer(selectionReducer, EMPTY_SELECTION);
  const [pinnedExpanded, setPinnedExpanded] = useState(true);
  const rootRef = useRef<HTMLElement>(null);

  const filterActive = isFilterActive(filter);
  const showPinned = ctx === 'inbox' && !filterActive;

  const items = useMemo(
    () =>
      messagesQ.status === 'ready'
        ? buildListItems({
            messages: messagesQ.data.items,
            pinned: pinnedAll,
            showPinned,
            pinnedExpanded,
            sort: filter.sort,
            now,
          })
        : [],
    [messagesQ, pinnedAll, showPinned, pinnedExpanded, filter.sort, now],
  );
  const order = useMemo(() => visibleMessageIds(items), [items]);
  const orderKey = order.join('|');

  // Drop selected ids that left the list (moved, deleted, filtered out).
  useEffect(() => {
    dispatch({ type: 'prune', order });
    // `order` is derived from `orderKey`; depending on the key avoids re-running on identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);

  useEffect(() => {
    if (!activeId) {
      document.title = title ? `${title} · Kaydet` : 'Kaydet';
    }
  }, [title, activeId]);

  const { run, dialog } = useMailListActions({
    ctx,
    onDone: (ids) => {
      if (ids.some((id) => selection.ids.has(id))) dispatch({ type: 'clear' });
    },
  });

  const idsFor = (rowId: string): string[] => (selection.ids.has(rowId) ? [...selection.ids] : [rowId]);

  const messagesById = useMemo(() => {
    const map = new Map<string, MessageSummary>();
    for (const item of items) if (item.kind === 'message') map.set(item.message.id, item.message);
    return map;
  }, [items]);
  const selectedMessages = [...selection.ids].flatMap((id) => messagesById.get(id) ?? []);

  const onToggleSelect = useEvent((id: string, shiftKey: boolean) =>
    dispatch(shiftKey ? { type: 'range', id, order } : { type: 'toggle', id }),
  );
  const onRowRun = useEvent((action: ActionId, id: string, arg?: string) => run(action, idsFor(id), arg));
  const onTogglePinnedSection = useEvent(() => setPinnedExpanded((v) => !v));
  const hrefFor = useEvent((id: string) => {
    const msg = messagesById.get(id);
    if (msg?.draft) {
      return `/a/${accountId}/compose/${msg.draftId ?? msg.id}`;
    }
    return `/a/${accountId}/f/${folderRef}/m/${id}${location.search}`;
  });
  const handleCloseReader = useEvent(() => {
    navigate(`/a/${accountId}/f/${folderRef}${location.search}`);
  });

  // Mobile Web: opening a message shows full-screen reader with back button
  if (isMobile && activeId) {
    return (
      <MailReader
        accountId={accountId}
        messageId={activeId}
        onBack={handleCloseReader}
        showBack={true}
        folderName={title}
      />
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (!rootRef.current?.contains(target)) return; // React events also bubble from portaled menus
    if (target.closest('input:not([type="checkbox"]), textarea, select, [contenteditable="true"]')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      dispatch({ type: 'selectAll', order });
    } else if (event.key === 'Escape' && selection.ids.size > 0) {
      dispatch({ type: 'clear' });
    }
  };

  // Unknown folder for this account (stale link): fall back to the account root, which redirects to Inbox.
  if (foldersQ.status === 'ready' && !isPinnedView && !folder) {
    return <Navigate to={`/a/${accountId}`} replace />;
  }

  const renderBody = () => {
    if (foldersQ.status === 'loading' || messagesQ.status === 'loading') return <MailListSkeleton />;
    if (messagesQ.status === 'error') {
      return <EmptyState role="alert" icon={ServerCrash} title="Liste yüklenemedi" description={messagesQ.message} />;
    }
    if (foldersQ.status === 'error') {
      return <EmptyState role="alert" icon={ServerCrash} title="Klasörler yüklenemedi" />;
    }
    if (order.length === 0) {
      // mobile: distinguish "folder empty" from "filter matched nothing" (strings are mobile's).
      return filterActive ? (
        <EmptyState
          icon={SearchIcon}
          title="Filtreyle eşleşen ileti yok"
          description="Farklı bir filtre deneyin veya filtreyi temizleyin."
          action={<Button onClick={clear}>Filtreyi temizle</Button>}
        />
      ) : (
        <EmptyState icon={Inbox} title="Bu klasör boş" description="Yeni iletiler geldiğinde burada görünecek." />
      );
    }
    return (
      <MailList
        label={title}
        items={items}
        selection={selection.ids}
        activeId={activeId}
        ctx={ctx}
        showRecipients={ctx === 'sent' || ctx === 'drafts'}
        now={now}
        labels={labels}
        folders={folders}
        hrefFor={hrefFor}
        hasMore={messagesQ.data.hasMore}
        isLoadingMore={messagesQ.data.isLoadingMore}
        onLoadMore={messagesQ.data.loadMore}
        onToggleSelect={onToggleSelect}
        onRun={onRowRun}
        onTogglePinnedSection={onTogglePinnedSection}
      />
    );
  };

  const hasReader = Boolean(activeId);

  return (
    <div className={`${styles.page} ${hasReader ? styles.hasReader : ''}`}>
      {/* Delegated shortcuts (Ctrl+A / Esc) for the list region; all controls inside are natively focusable. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <section ref={rootRef} className={styles.listPane} aria-label={title || 'İletiler'} onKeyDown={onKeyDown}>
        <FilterBar filter={filter} labels={labels} onChange={update} onClear={clear} />
        <MailToolbar
          title={title}
          selectedCount={selection.ids.size}
          totalCount={order.length}
          actions={availableActions(ctx, selectedMessages)}
          folders={folders}
          labels={labels}
          currentFolderId={folderRef}
          onToggleAll={() => dispatch(selection.ids.size === order.length ? { type: 'clear' } : { type: 'selectAll', order })}
          onClear={() => dispatch({ type: 'clear' })}
          onRun={(action, arg) => run(action, [...selection.ids], arg)}
        />
        {renderBody()}
        {dialog}
      </section>

      {hasReader && (
        <section className={styles.readerPane} aria-label="İleti okuyucu">
          <MailReader
            accountId={accountId}
            messageId={activeId!}
            onBack={handleCloseReader}
            showBack={false}
            folderName={title}
          />
        </section>
      )}
    </div>
  );
}

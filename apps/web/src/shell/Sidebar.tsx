import { Pin, SquarePen } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useFolders, usePinnedCount } from '../data/MailDataContext';
import { PINNED_FOLDER } from '../data/types';
import type { FolderView } from '../data/types';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Skeleton } from '../ui/Skeleton';
import { folderIcons } from './folderIcons';
import { useShell } from './ShellContext';
import { SidebarItem } from './SidebarItem';
import { useCollapsedFolders } from './useCollapsedFolders';
import styles from './Sidebar.module.css';

/** A row is hidden when any ancestor is collapsed (mobile `_isHidden`, depth-based). */
function isHidden(tree: FolderView[], index: number, collapsed: ReadonlySet<string>): boolean {
  let depth = tree[index]?.depth ?? 0;
  for (let k = index - 1; k >= 0 && depth > 0; k--) {
    const node = tree[k];
    if (node && node.depth < depth) {
      depth = node.depth;
      if (collapsed.has(node.id)) return true;
    }
  }
  return false;
}

/**
 * Sidebar (`<aside>` + `<nav>`). Order and terminology follow mobile's folder panel:
 * "Sık Kullanılanlar" (favorite folders) → folder tree → virtual "Sabitlenenler".
 * Labels are NOT navigation on mobile (they live in the list filter), so they are not here.
 */
export function Sidebar({ accountId }: { accountId: string }) {
  const { mode, drawerOpen, closeDrawer } = useShell();
  const location = useLocation();
  const navigateTo = useNavigate();
  const folders = useFolders(accountId);
  const pinnedCount = usePinnedCount(accountId);
  const { collapsed, toggle } = useCollapsedFolders(accountId);
  const firstFocus = useRef<HTMLButtonElement>(null);

  const isDrawer = mode === 'mobile';
  const compact = mode === 'tablet';

  // Drawer focus management: move focus in on open, close on Escape.
  useEffect(() => {
    if (!isDrawer || !drawerOpen) return;
    firstFocus.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isDrawer, drawerOpen, closeDrawer]);

  // Filters persist across folder changes (mobile keeps its filter state), so links carry the query.
  const link = (folderRef: string) => ({ pathname: `/a/${accountId}/f/${folderRef}`, search: location.search });
  const navigate = isDrawer ? closeDrawer : undefined;

  const renderFolders = () => {
    if (folders.status === 'loading') {
      return (
        <ul className={styles.list} aria-busy="true">
          {Array.from({ length: 7 }, (_, i) => (
            <li key={i} className={styles.skeletonRow}>
              <Skeleton width={20} height={20} circle />
              {!compact && <Skeleton width={`${50 + ((i * 13) % 35)}%`} height={12} />}
            </li>
          ))}
        </ul>
      );
    }
    if (folders.status === 'error') {
      return <p className={styles.error} role="alert">Klasörler yüklenemedi.</p>;
    }

    const tree = folders.data;
    const favorites = tree.filter((f) => f.isFavorite);
    return (
      <>
        {!compact && favorites.length > 0 && (
          <>
            <h2 className={styles.heading} id="favorites-heading">
              Sık Kullanılanlar
            </h2>
            <ul className={styles.list} aria-labelledby="favorites-heading">
              {favorites.map((f) => (
                <SidebarItem
                  key={`fav-${f.id}`}
                  to={link(f.id)}
                  icon={folderIcons[f.role]}
                  label={f.name}
                  badge={f.role === 'drafts' ? undefined : f.unreadCount}
                  onNavigate={navigate}
                />
              ))}
            </ul>
            <hr className={styles.divider} />
          </>
        )}
        <ul className={styles.list} aria-label="Tüm klasörler">
          {tree.map((f, i) => {
            if (compact && f.depth > 0) return null;
            if (isHidden(tree, i, collapsed)) return null;
            return (
              <SidebarItem
                key={f.id}
                to={link(f.id)}
                icon={folderIcons[f.role]}
                label={f.name}
                depth={f.depth}
                compact={compact}
                // mobile: Drafts carries no unread badge.
                badge={f.role === 'drafts' ? undefined : f.unreadCount}
                expandable={f.hasChildren ? { expanded: !collapsed.has(f.id), onToggle: () => toggle(f.id) } : undefined}
                onNavigate={navigate}
              />
            );
          })}
          {/* Virtual folder: every message carrying \Flagged, wherever it lives. */}
          <SidebarItem
            to={link(PINNED_FOLDER)}
            icon={Pin}
            label="Sabitlenenler"
            badge={pinnedCount}
            compact={compact}
            onNavigate={navigate}
          />
        </ul>
      </>
    );
  };

  return (
    <>
      {isDrawer && drawerOpen && <div className={styles.scrim} onClick={closeDrawer} aria-hidden="true" />}
      <aside className={styles.sidebar} data-open={drawerOpen ? '' : undefined} inert={isDrawer && !drawerOpen}>
        <nav aria-label="Klasörler" className={styles.nav}>
          <div className={styles.compose}>
            {compact ? (
              <IconButton
                ref={firstFocus}
                icon={SquarePen}
                label="Yeni ileti"
                className={styles.composeIcon}
                onClick={() => navigateTo(`/a/${accountId}/compose`)}
              />
            ) : (
              <Button
                ref={firstFocus}
                variant="primary"
                icon={SquarePen}
                className={styles.composeButton}
                onClick={() => {
                  navigateTo(`/a/${accountId}/compose`);
                  if (isDrawer) closeDrawer();
                }}
              >
                Yeni ileti
              </Button>
            )}
          </div>
          <div className={styles.scroll}>{renderFolders()}</div>
        </nav>
      </aside>
    </>
  );
}

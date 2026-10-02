import { ChevronRight } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { containers } from '@kaydet/tokens';
import type { FolderView, LabelView } from '../../data/types';
import { Button } from '../../ui/Button';
import type { ActionId, ListContext } from './actions';
import type { ListItem } from './listItems';
import { MailListRow } from './MailListRow';
import type { RowLayout } from './MailListRow';
import styles from './MailList.module.css';

export interface MailListProps {
  /** Accessible name of the list (folder name). */
  label: string;
  items: ListItem[];
  selection: ReadonlySet<string>;
  activeId: string | undefined;
  ctx: ListContext;
  showRecipients: boolean;
  now: Date;
  labels: LabelView[];
  folders: FolderView[];
  hrefFor: (messageId: string) => string;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onToggleSelect: (id: string, shiftKey: boolean) => void;
  onRun: (action: ActionId, id: string, arg?: string) => void;
  onTogglePinnedSection: () => void;
}

const isTypingTarget = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/**
 * List container: owns scrolling, width-driven row layout, the roving tab stop and keyboard
 * navigation. Rows are dumb and memoized; `items` is a flat array, so swapping this body for a
 * windowed renderer (TanStack Virtual) and cursor pagination later changes only this file.
 */
export function MailList({
  label,
  items,
  selection,
  activeId,
  ctx,
  showRecipients,
  now,
  labels,
  folders,
  hrefFor,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onToggleSelect,
  onRun,
  onTogglePinnedSection,
}: MailListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [layout, setLayout] = useState<RowLayout>('wide');
  const [focusId, setFocusId] = useState<string | null>(null);

  // Row layout follows the list's own width (works with any sidebar/reader arrangement).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = (width: number) => setLayout(width >= containers.listWide ? 'wide' : 'stacked');
    measure(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => entry && measure(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const messageIds = items.flatMap((i) => (i.kind === 'message' ? [i.message.id] : []));
  const tabId = focusId && messageIds.includes(focusId) ? focusId : messageIds[0];

  const onFocusRow = useCallback((id: string) => setFocusId(id), []);

  const moveFocus = (from: HTMLElement, to: 'next' | 'prev' | 'first' | 'last') => {
    const links = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-row-link]') ?? []);
    const row = from.closest('[data-row-id]');
    const index = links.findIndex((l) => l.closest('[data-row-id]') === row);
    const target =
      to === 'first' ? 0 : to === 'last' ? links.length - 1 : Math.min(links.length - 1, Math.max(0, index + (to === 'next' ? 1 : -1)));
    links[target]?.focus();
    links[target]?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const target = event.target as HTMLElement;
    if (isTypingTarget(target) || event.altKey) return;
    const rowEl = target.closest<HTMLElement>('[data-row-id]');
    if (!rowEl) return;
    const id = rowEl.dataset.rowId ?? '';

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        return moveFocus(target, 'next');
      case 'ArrowUp':
        event.preventDefault();
        return moveFocus(target, 'prev');
      case 'Home':
        event.preventDefault();
        return moveFocus(target, 'first');
      case 'End':
        event.preventDefault();
        return moveFocus(target, 'last');
    }
    if (event.ctrlKey || event.metaKey) return;

    // Shortcuts act on the focused row (the page widens this to the selection when it is part of it).
    if (event.key === 'Delete' || event.key === '#') {
      event.preventDefault();
      onRun('delete', id);
    } else if (event.key.toLowerCase() === 'e' && ctx !== 'drafts') {
      event.preventDefault();
      onRun(ctx === 'archive' || ctx === 'trash' || ctx === 'junk' ? 'restore' : 'archive', id);
    }
  };

  return (
    <div ref={scroller} className={styles.scroller}>
      {/* Keyboard delegation for the roving-tabindex list (arrows/Home/End/shortcuts); each row has real focusable controls. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <ul ref={listRef} className={styles.list} aria-label={label} onKeyDown={onKeyDown}>
        {items.map((item) => {
          if (item.kind === 'date') {
            return (
              <li key={`d-${item.label}`} className={styles.groupHeader}>
                <h3 className={styles.groupTitle}>{item.label}</h3>
              </li>
            );
          }
          if (item.kind === 'pinned-header') {
            return (
              <li key="pinned-header" className={styles.groupHeader}>
                <h3 className={`${styles.groupTitle} ${styles.flush}`}>
                  <button
                    type="button"
                    className={styles.pinnedToggle}
                    aria-expanded={item.expanded}
                    onClick={onTogglePinnedSection}
                  >
                    <ChevronRight size={14} className={styles.chevron} aria-hidden="true" />
                    Sabitlenenler
                    <span className={styles.count}>{item.count}</span>
                  </button>
                </h3>
              </li>
            );
          }
          const m = item.message;
          return (
            <MailListRow
              key={`${item.section}-${m.id}`}
              message={m}
              selected={selection.has(m.id)}
              active={activeId === m.id}
              layout={layout}
              ctx={ctx}
              showRecipients={showRecipients}
              tabStop={m.id === tabId}
              now={now}
              href={hrefFor(m.id)}
              labels={labels}
              folders={folders}
              onToggleSelect={onToggleSelect}
              onRun={onRun}
              onFocusRow={onFocusRow}
            />
          );
        })}
      </ul>
      {hasMore && (
        <div className={styles.more}>
          <Button variant="ghost" onClick={onLoadMore} disabled={isLoadingMore}>
            {isLoadingMore ? 'Yükleniyor…' : 'Daha fazla ileti yükle'}
          </Button>
        </div>
      )}
    </div>
  );
}

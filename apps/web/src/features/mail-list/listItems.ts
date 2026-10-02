import { formatGroupHeader } from '../../lib/dates';
import type { MessageSort, MessageSummary } from '../../data/types';

/**
 * Flat, virtualization-friendly description of what the list renders.
 * mobile: `MailListItem` (PinnedSectionItem / DateHeaderItem / MessageItem).
 */
export type ListItem =
  | { kind: 'pinned-header'; count: number; expanded: boolean }
  | { kind: 'date'; label: string }
  | { kind: 'message'; message: MessageSummary; section: 'pinned' | 'list' };

export interface BuildListItemsInput {
  messages: MessageSummary[];
  /** Pinned messages of the account (Inbox section). */
  pinned: MessageSummary[];
  /** mobile: only in the Inbox and only while no filter is active. */
  showPinned: boolean;
  pinnedExpanded: boolean;
  sort: MessageSort;
  now: Date;
}

export function buildListItems({ messages, pinned, showPinned, pinnedExpanded, sort, now }: BuildListItemsInput): ListItem[] {
  const items: ListItem[] = [];
  const hasPinned = showPinned && pinned.length > 0;

  if (hasPinned) {
    items.push({ kind: 'pinned-header', count: pinned.length, expanded: pinnedExpanded });
    if (pinnedExpanded) {
      for (const message of pinned) items.push({ kind: 'message', message, section: 'pinned' });
    }
  }

  // Pinned messages live in their own section; the regular list excludes them (mobile).
  const visible = showPinned ? messages.filter((m) => !m.pinned) : messages;
  const groupByDate = sort === 'dateDesc' || sort === 'dateAsc';

  let lastLabel: string | null = null;
  for (const message of visible) {
    if (groupByDate) {
      const label = formatGroupHeader(new Date(message.date), now);
      if (label !== lastLabel) {
        items.push({ kind: 'date', label });
        lastLabel = label;
      }
    }
    items.push({ kind: 'message', message, section: 'list' });
  }
  return items;
}

/** Message ids in visual order (used by select-all and range selection). */
export function visibleMessageIds(items: ListItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) if (item.kind === 'message') ids.push(item.message.id);
  return ids;
}

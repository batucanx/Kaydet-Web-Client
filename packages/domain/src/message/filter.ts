/**
 * List filter and sort.
 *
 * SOURCE: mobile `lib/app/providers.dart` → `MessageSort`, `MessageFilter` (+ `MessageFilter.apply`).
 * PURPOSE: Independent toggles (NOT radio categories) narrow the current list; the sort has four modes.
 *          Sender/subject sorting compares Turkish-lower-cased text by UTF-16 code unit — deliberately not
 *          locale collation — exactly as mobile does, so the same folder sorts the same way on both apps.
 *          `dateAsc` is the exact reverse of `dateDesc`.
 * WEB USAGE: the server applies it when building list pages; the web mock/UI use `isFilterActive` and the
 *            empty filter. Field names are the UI's (`unread`/`pinned`/`attachments`/`label`) rather than
 *            mobile's (`unreadOnly`/`flaggedOnly`/`withAttachmentsOnly`/`labelName`); `pinned` = IMAP
 *            `\Flagged` = "Sabitle".
 */
import { trLower } from '../turkish/index.ts';

export const MESSAGE_SORTS = ['dateDesc', 'dateAsc', 'senderAZ', 'subjectAZ'] as const;
export type MessageSort = (typeof MESSAGE_SORTS)[number];

export interface MessageFilter {
  readonly unread: boolean;
  readonly pinned: boolean;
  readonly attachments: boolean;
  /** Label NAME (labels are unique per account by name, as on mobile). */
  readonly label: string | null;
  readonly sort: MessageSort;
}

export const EMPTY_MESSAGE_FILTER: MessageFilter = {
  unread: false,
  pinned: false,
  attachments: false,
  label: null,
  sort: 'dateDesc',
};

/** Is anything narrowing or re-ordering the list? (Drives the filter badge / "clear" affordance.) */
export function isFilterActive(f: MessageFilter): boolean {
  return f.unread || f.pinned || f.attachments || f.label !== null || f.sort !== 'dateDesc';
}

/** The message fields the filter/sort reads. */
export interface FilterableMessage {
  readonly seen: boolean;
  readonly pinned: boolean;
  readonly hasAttachments: boolean;
  readonly labels: readonly string[];
  readonly from: { readonly name: string; readonly email: string };
  readonly subject: string;
  /** ISO-8601 instant. */
  readonly date: string;
}

const compareUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `dateDesc` order: newest first (stable for equal timestamps). */
export function sortByDateDesc<T extends { readonly date: string }>(messages: readonly T[]): T[] {
  return [...messages].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

/** Filters and sorts a list (the input is treated as a set; the result is a new array). */
export function applyMessageFilter<T extends FilterableMessage>(messages: readonly T[], filter: MessageFilter): T[] {
  let result = sortByDateDesc(messages);
  if (filter.unread) result = result.filter((m) => !m.seen);
  if (filter.pinned) result = result.filter((m) => m.pinned);
  if (filter.attachments) result = result.filter((m) => m.hasAttachments);
  if (filter.label !== null) {
    const name = filter.label;
    result = result.filter((m) => m.labels.includes(name));
  }

  switch (filter.sort) {
    case 'dateDesc':
      return result;
    case 'dateAsc':
      return result.reverse();
    case 'senderAZ': {
      const key = (m: T) => trLower(m.from.name !== '' ? m.from.name : m.from.email);
      return result.sort((a, b) => compareUnits(key(a), key(b)));
    }
    case 'subjectAZ':
      return result.sort((a, b) => compareUnits(trLower(a.subject), trLower(b.subject)));
  }
}

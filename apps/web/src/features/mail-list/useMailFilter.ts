import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EMPTY_FILTER } from '../../data/types';
import type { MailFilter, MessageSort } from '../../data/types';

const SORTS: readonly MessageSort[] = ['dateDesc', 'dateAsc', 'senderAZ', 'subjectAZ'];

/**
 * Filter state lives in the URL (`?unread=1&pinned=1&att=1&label=İş&sort=senderAZ`): shareable,
 * back/forward friendly, survives reloads. Unrelated params are preserved. Filters intentionally
 * persist when changing folder — mobile keeps `messageFilterProvider` across folder selection.
 */
export function useMailFilter(): {
  filter: MailFilter;
  update: (patch: Partial<MailFilter>) => void;
  clear: () => void;
} {
  const [params, setParams] = useSearchParams();

  const filter = useMemo<MailFilter>(() => {
    const sort = params.get('sort');
    return {
      unread: params.get('unread') === '1',
      pinned: params.get('pinned') === '1',
      attachments: params.get('att') === '1',
      label: params.get('label'),
      sort: SORTS.find((s) => s === sort) ?? EMPTY_FILTER.sort,
    };
  }, [params]);

  const write = useCallback(
    (next: MailFilter) => {
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          const set = (key: string, value: string | null) => (value === null ? out.delete(key) : out.set(key, value));
          set('unread', next.unread ? '1' : null);
          set('pinned', next.pinned ? '1' : null);
          set('att', next.attachments ? '1' : null);
          set('label', next.label);
          set('sort', next.sort === EMPTY_FILTER.sort ? null : next.sort);
          return out;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const update = useCallback((patch: Partial<MailFilter>) => write({ ...filter, ...patch }), [filter, write]);
  const clear = useCallback(() => write(EMPTY_FILTER), [write]);
  return { filter, update, clear };
}

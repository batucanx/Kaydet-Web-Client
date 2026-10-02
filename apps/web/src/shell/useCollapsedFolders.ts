import { useCallback, useState } from 'react';

/**
 * Per-account collapsed folder ids. Same storage key as mobile
 * (`kaydet.collapsedFolders.<accountId>`, AppSettingsStore.readCollapsedFolders) — a UI preference,
 * not mail data, so `localStorage` is appropriate.
 */
const key = (accountId: string): string => `kaydet.collapsedFolders.${accountId}`;

function read(accountId: string): Set<string> {
  try {
    const raw = localStorage.getItem(key(accountId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

export function useCollapsedFolders(accountId: string): {
  collapsed: ReadonlySet<string>;
  toggle: (folderId: string) => void;
} {
  const [state, setState] = useState<{ accountId: string; ids: Set<string> }>(() => ({
    accountId,
    ids: read(accountId),
  }));

  // Account switch: re-read for the new account (derived during render, no effect needed).
  const current = state.accountId === accountId ? state : { accountId, ids: read(accountId) };
  if (current !== state) setState(current);

  const toggle = useCallback(
    (folderId: string) => {
      setState((prev) => {
        const ids = new Set(prev.ids);
        if (ids.has(folderId)) ids.delete(folderId);
        else ids.add(folderId);
        try {
          localStorage.setItem(key(accountId), JSON.stringify([...ids]));
        } catch {
          /* non-fatal */
        }
        return { accountId, ids };
      });
    },
    [accountId],
  );

  return { collapsed: current.ids, toggle };
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type {
  FolderRole,
  SearchAccountScope,
  SearchFilters,
  SearchFolder,
  SearchPageDTO,
  SearchResultDTO,
} from '@kaydet/domain';
import {
  EMPTY_SEARCH_FILTERS,
  tokenizeSearchQuery,
} from '@kaydet/domain';
import { searchMessages } from '../../data/api/search';
import { useMailActions } from '../../data/MailDataContext';

export interface UseSearchOptions {
  accountId: string;
}

export type SearchStatus = 'idle' | 'loading' | 'error' | 'ready';

export function useSearch({ accountId }: UseSearchOptions) {
  const [searchParams, setSearchParams] = useSearchParams();
  const actions = useMailActions();

  // 1. Read query params from URL
  const queryParam = searchParams.get('q') ?? '';
  const accountsScopeParam = (searchParams.get('accounts') as 'all' | 'account') ?? 'account';
  const attachmentsParam = searchParams.get('attachments') === 'true';
  const includeDeletedParam = searchParams.get('includeDeleted') === 'true';
  const folderRoleParam = (searchParams.get('folderRole') as FolderRole) || undefined;
  const folderNameParam = searchParams.get('folderName') ?? undefined;

  const folderScope: SearchFolder | null = useMemo(
    () =>
      folderRoleParam
        ? folderRoleParam === 'custom' && folderNameParam
          ? { role: 'custom', name: folderNameParam }
          : { role: folderRoleParam as Exclude<FolderRole, 'custom'> }
        : null,
    [folderRoleParam, folderNameParam],
  );

  const currentFilters: SearchFilters = useMemo(
    () => ({
      attachmentsOnly: attachmentsParam,
      includeDeleted: includeDeletedParam,
      folder: folderScope,
    }),
    [attachmentsParam, includeDeletedParam, folderScope],
  );

  const trimmed = queryParam.trim();
  const tokens = tokenizeSearchQuery(trimmed);
  const isQueryEmpty = tokens.length === 0;

  // Local state
  const [results, setResults] = useState<SearchResultDTO[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [retryCount, setRetryCount] = useState<number>(0);

  // Monotonic request ID & AbortController ref for race-condition prevention
  const requestIdRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const retry = useCallback(() => setRetryCount((c) => c + 1), []);

  // Helper to update URL search params cleanly
  const updateUrlParams = useCallback(
    (updates: {
      q?: string;
      accounts?: 'all' | 'account';
      filters?: Partial<SearchFilters>;
    }) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);

          if (updates.q !== undefined) {
            if (updates.q.trim()) {
              next.set('q', updates.q.trim());
            } else {
              next.delete('q');
            }
          }

          if (updates.accounts !== undefined) {
            if (updates.accounts === 'all') {
              next.set('accounts', 'all');
            } else {
              next.delete('accounts');
            }
          }

          if (updates.filters !== undefined) {
            const f = updates.filters;
            if (f.attachmentsOnly !== undefined) {
              if (f.attachmentsOnly) next.set('attachments', 'true');
              else next.delete('attachments');
            }
            if (f.includeDeleted !== undefined) {
              if (f.includeDeleted) next.set('includeDeleted', 'true');
              else next.delete('includeDeleted');
            }
            if (f.folder !== undefined) {
              if (f.folder === null) {
                next.delete('folderRole');
                next.delete('folderName');
              } else if (f.folder.role === 'custom') {
                next.set('folderRole', 'custom');
                next.set('folderName', f.folder.name);
              } else {
                next.set('folderRole', f.folder.role);
                next.delete('folderName');
              }
            }
          }

          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Execute search whenever URL query params change
  useEffect(() => {
    // If query has no searchable tokens, do not hit the backend
    if (isQueryEmpty) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      return;
    }

    // Abort previous in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const currentRequestId = ++requestIdRef.current;
    void Promise.resolve().then(() => {
      if (currentRequestId === requestIdRef.current) {
        setStatus('loading');
        setErrorMessage(null);
      }
    });

    const accountsScope: SearchAccountScope =
      accountsScopeParam === 'all'
        ? { kind: 'all' }
        : { kind: 'account', accountId };

    searchMessages(
      undefined,
      {
        q: trimmed,
        accounts: accountsScope,
        filters: currentFilters,
        limit: 30,
      },
      abortController.signal,
    )
      .then((page: SearchPageDTO) => {
        // Stale check
        if (currentRequestId === requestIdRef.current) {
          setResults(page.items);
          setNextCursor(page.nextCursor);
          setStatus('ready');
        }
      })
      .catch((err) => {
        if (currentRequestId === requestIdRef.current) {
          // Ignore abort errors
          if (err instanceof DOMException && err.name === 'AbortError') {
            return;
          }
          if (err instanceof Error && err.name === 'AbortError') {
            return;
          }
          setErrorMessage(err instanceof Error ? err.message : 'Arama yapılamadı.');
          setStatus('error');
        }
      });

    return () => {
      abortController.abort();
    };
  }, [
    trimmed,
    isQueryEmpty,
    accountsScopeParam,
    currentFilters,
    accountId,
    retryCount,
  ]);

  // Load more / pagination
  const loadMore = useCallback(async () => {
    if (!nextCursor || isLoadingMore || status !== 'ready') return;

    setIsLoadingMore(true);
    const accountsScope: SearchAccountScope =
      accountsScopeParam === 'all'
        ? { kind: 'all' }
        : { kind: 'account', accountId };

    try {
      const page = await searchMessages(undefined, {
        q: queryParam.trim(),
        accounts: accountsScope,
        filters: currentFilters,
        cursor: nextCursor,
        limit: 30,
      });

      setResults((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch {
      // Ignore load more errors
    } finally {
      setIsLoadingMore(false);
    }
  }, [
    nextCursor,
    isLoadingMore,
    status,
    accountsScopeParam,
    accountId,
    queryParam,
    currentFilters,
  ]);

  // Optimistic actions
  const togglePin = useCallback(
    (id: string) => {
      setResults((prev) =>
        prev.map((r) => {
          if (r.message.id !== id) return r;
          const nextPinned = !r.message.pinned;
          actions.setPinned([id], nextPinned);
          return {
            ...r,
            message: { ...r.message, pinned: nextPinned },
          };
        }),
      );
    },
    [actions],
  );

  const toggleSeen = useCallback(
    (id: string) => {
      setResults((prev) =>
        prev.map((r) => {
          if (r.message.id !== id) return r;
          const nextSeen = !r.message.seen;
          actions.setSeen([id], nextSeen);
          return {
            ...r,
            message: { ...r.message, seen: nextSeen },
          };
        }),
      );
    },
    [actions],
  );

  const deleteMessage = useCallback(
    (id: string) => {
      actions.remove([id]);
      setResults((prev) => prev.filter((r) => r.message.id !== id));
    },
    [actions],
  );

  const clearFilters = useCallback(() => {
    updateUrlParams({ filters: EMPTY_SEARCH_FILTERS });
  }, [updateUrlParams]);

  const setScope = useCallback(
    (scope: 'all' | 'account') => {
      updateUrlParams({ accounts: scope });
    },
    [updateUrlParams],
  );

  const setFilters = useCallback(
    (patch: Partial<SearchFilters>) => {
      updateUrlParams({ filters: patch });
    },
    [updateUrlParams],
  );

  const setQuery = useCallback(
    (newQuery: string) => {
      updateUrlParams({ q: newQuery });
    },
    [updateUrlParams],
  );

  return {
    query: queryParam,
    accountsScope: accountsScopeParam,
    filters: currentFilters,
    results: isQueryEmpty ? [] : results,
    status: isQueryEmpty ? 'idle' : status,
    errorMessage: isQueryEmpty ? null : errorMessage,
    hasMore: isQueryEmpty ? false : Boolean(nextCursor),
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
  };
}

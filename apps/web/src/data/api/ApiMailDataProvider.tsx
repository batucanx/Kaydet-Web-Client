import {
  isFilterActive,
  messageListKey,
  pageMatchesRequest,
  predictActions,
  sortByDateDesc,
} from '@kaydet/domain';
import type {
  ActionContext,
  MessageAction,
  MessageScope,
} from '@kaydet/domain';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { MailDataProvider } from '../MailDataContext';
import { PINNED_FOLDER } from '../types';
import type {
  AccountView,
  FolderView,
  LabelView,
  Loadable,
  MailActions,
  MailDataSource,
  MessageDTO,
  MessagePage,
  MessageQuery,
  MessageSummary,
  UndoHandle,
} from '../types';
import type { ApiClient } from './client';
import { defaultApiClient } from './client';
import * as accountsApi from './accounts';
import * as actionsApi from './actions';
import * as foldersApi from './folders';
import * as labelsApi from './labels';
import * as messagesApi from './messages';
import { isAbortError } from './errors';

const PAGE_SIZE = 30;

interface CacheState {
  accounts: Loadable<AccountView[]>;
  foldersByAccount: Record<string, Loadable<FolderView[]>>;
  labelsByAccount: Record<string, Loadable<LabelView[]>>;
  pinnedByAccount: Record<string, MessageSummary[]>;
  messagesDetail: Record<string, Loadable<MessageDTO>>;
  messageLists: Record<
    string,
    {
      items: MessageSummary[];
      nextCursor: string | null;
      hasMore: boolean;
      status: 'loading' | 'ready' | 'error';
      errorMessage?: string;
      isLoadingMore: boolean;
    }
  >;
}

interface StoreContextValue {
  state: CacheState;
  client: ApiClient;
  loadAccounts: () => Promise<void>;
  loadFolders: (accountId: string) => Promise<void>;
  loadLabels: (accountId: string) => Promise<void>;
  loadPinned: (accountId: string) => Promise<void>;
  loadMessagesFirstPage: (query: MessageQuery, signal?: AbortSignal) => Promise<void>;
  loadMessagesNextPage: (query: MessageQuery) => Promise<void>;
  loadMessageDetail: (accountId: string, messageId: string, signal?: AbortSignal) => Promise<void>;
  applyActions: (
    ids: string[],
    actionBuilder: (m: MessageSummary) => MessageAction[],
  ) => Promise<UndoHandle | null>;
}

const StoreContext = createContext<StoreContextValue | null>(null);

function useStore(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('ApiMailDataProvider is missing');
  return ctx;
}

export function ApiMailDataProvider({
  client = defaultApiClient,
  children,
}: {
  client?: ApiClient;
  children: ReactNode;
}) {
  const [accounts, setAccounts] = useState<Loadable<AccountView[]>>({ status: 'loading' });
  const [foldersByAccount, setFoldersByAccount] = useState<Record<string, Loadable<FolderView[]>>>({});
  const [labelsByAccount, setLabelsByAccount] = useState<Record<string, Loadable<LabelView[]>>>({});
  const [pinnedByAccount, setPinnedByAccount] = useState<Record<string, MessageSummary[]>>({});
  const [messagesDetail, setMessagesDetail] = useState<Record<string, Loadable<MessageDTO>>>({});
  const [messageLists, setMessageLists] = useState<CacheState['messageLists']>({});

  // In-flight tracker to prevent duplicate concurrent or loop fetches
  const inFlight = useRef<Set<string>>(new Set());

  // Message registry to map messageId -> message summary across all loaded pages
  const messagesById = useRef<Map<string, MessageSummary>>(new Map());

  // Keep a ref of all current messages and cache for mutations and rollbacks
  const latestMessageLists = useRef(messageLists);
  useEffect(() => {
    latestMessageLists.current = messageLists;
  }, [messageLists]);

  const latestMessagesDetail = useRef(messagesDetail);
  useEffect(() => {
    latestMessagesDetail.current = messagesDetail;
  }, [messagesDetail]);

  const latestFolders = useRef(foldersByAccount);
  useEffect(() => {
    latestFolders.current = foldersByAccount;
  }, [foldersByAccount]);

  const latestLabels = useRef(labelsByAccount);
  useEffect(() => {
    latestLabels.current = labelsByAccount;
  }, [labelsByAccount]);

  const loadAccounts = useCallback(async () => {
    if (inFlight.current.has('accounts')) return;
    inFlight.current.add('accounts');
    setAccounts((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    try {
      const items = await accountsApi.listAccounts(client);
      setAccounts({ status: 'ready', data: items });
    } catch (err) {
      if (isAbortError(err)) return;
      setAccounts({
        status: 'error',
        message: err instanceof Error ? err.message : 'Hesaplar yüklenemedi.',
      });
    } finally {
      inFlight.current.delete('accounts');
    }
  }, [client]);

  const loadFolders = useCallback(
    async (accountId: string) => {
      const key = `folders:${accountId}`;
      if (!accountId || inFlight.current.has(key)) return;
      inFlight.current.add(key);

      setFoldersByAccount((prev) => ({
        ...prev,
        [accountId]: prev[accountId]?.status === 'ready' ? prev[accountId] : { status: 'loading' },
      }));
      try {
        const items = await foldersApi.listFolders(client, accountId);
        setFoldersByAccount((prev) => ({
          ...prev,
          [accountId]: { status: 'ready', data: items },
        }));
      } catch (err) {
        if (isAbortError(err)) return;
        setFoldersByAccount((prev) => ({
          ...prev,
          [accountId]: {
            status: 'error',
            message: err instanceof Error ? err.message : 'Klasörler yüklenemedi.',
          },
        }));
      } finally {
        inFlight.current.delete(key);
      }
    },
    [client],
  );

  const loadLabels = useCallback(
    async (accountId: string) => {
      const key = `labels:${accountId}`;
      if (!accountId || inFlight.current.has(key)) return;
      inFlight.current.add(key);

      setLabelsByAccount((prev) => ({
        ...prev,
        [accountId]: prev[accountId]?.status === 'ready' ? prev[accountId] : { status: 'loading' },
      }));
      try {
        const items = await labelsApi.listLabels(client, accountId);
        setLabelsByAccount((prev) => ({
          ...prev,
          [accountId]: { status: 'ready', data: items },
        }));
      } catch (err) {
        if (isAbortError(err)) return;
        setLabelsByAccount((prev) => ({
          ...prev,
          [accountId]: {
            status: 'error',
            message: err instanceof Error ? err.message : 'Etiketler yüklenemedi.',
          },
        }));
      } finally {
        inFlight.current.delete(key);
      }
    },
    [client],
  );

  const loadPinned = useCallback(
    async (accountId: string) => {
      const key = `pinned:${accountId}`;
      if (!accountId || inFlight.current.has(key)) return;
      inFlight.current.add(key);

      try {
        const page = await messagesApi.listMessages(client, accountId, {
          scope: { kind: 'pinned' },
          limit: 100,
        });
        for (const item of page.items) {
          messagesById.current.set(item.id, item);
        }
        setPinnedByAccount((prev) => ({
          ...prev,
          [accountId]: page.items,
        }));
      } catch {
        // Suppress pinned fetch failures
      } finally {
        inFlight.current.delete(key);
      }
    },
    [client],
  );

  const loadMessageDetail = useCallback(
    async (accountId: string, messageId: string, signal?: AbortSignal) => {
      const key = `${accountId}:${messageId}`;
      if (!accountId || !messageId) return;

      if (latestMessagesDetail.current[key]?.status === 'ready') return;
      if (signal?.aborted) return;

      setMessagesDetail((prev) => ({
        ...prev,
        [key]: prev[key]?.status === 'ready' ? prev[key] : { status: 'loading' },
      }));

      try {
        const msg = await messagesApi.getMessage(client, messageId, signal);
        if (signal?.aborted) return;

        // Authorization & scoping check: message must belong to the active account URL
        if (msg.accountId !== accountId) {
          setMessagesDetail((prev) => ({
            ...prev,
            [key]: { status: 'error', message: 'İleti bulunamadı.' },
          }));
          return;
        }

        messagesById.current.set(msg.id, msg);
        setMessagesDetail((prev) => ({
          ...prev,
          [key]: { status: 'ready', data: msg },
        }));
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) return;
        const msgStr = err instanceof Error ? err.message : '';
        const isNotFound = msgStr.includes('message_not_found') || msgStr.includes('not_found');
        setMessagesDetail((prev) => ({
          ...prev,
          [key]: {
            status: 'error',
            message: isNotFound ? 'İleti bulunamadı.' : 'İleti yüklenemedi. Lütfen tekrar deneyin.',
          },
        }));
      }
    },
    [client],
  );

  const loadMessagesFirstPage = useCallback(
    async (query: MessageQuery, signal?: AbortSignal) => {
      const scope: MessageScope =
        query.folder === PINNED_FOLDER
          ? { kind: 'pinned' }
          : { kind: 'folder', folderId: query.folder };
      const key = messageListKey(query.accountId, scope, query.filter);

      setMessageLists((prev) => ({
        ...prev,
        [key]: {
          items: prev[key]?.items ?? [],
          nextCursor: prev[key]?.nextCursor ?? null,
          hasMore: prev[key]?.hasMore ?? false,
          status: 'loading',
          isLoadingMore: false,
        },
      }));

      try {
        const page = await messagesApi.listMessages(
          client,
          query.accountId,
          { scope, filter: query.filter, cursor: null, limit: PAGE_SIZE },
          signal,
        );

        if (!pageMatchesRequest(page, { accountId: query.accountId, scope })) {
          return;
        }

        for (const item of page.items) {
          messagesById.current.set(item.id, item);
        }

        setMessageLists((prev) => ({
          ...prev,
          [key]: {
            items: page.items,
            nextCursor: page.nextCursor,
            hasMore: page.nextCursor !== null,
            status: 'ready',
            isLoadingMore: false,
          },
        }));
      } catch (err) {
        if (isAbortError(err)) return;
        setMessageLists((prev) => ({
          ...prev,
          [key]: {
            items: prev[key]?.items ?? [],
            nextCursor: prev[key]?.nextCursor ?? null,
            hasMore: prev[key]?.hasMore ?? false,
            status: 'error',
            errorMessage: err instanceof Error ? err.message : 'İletiler yüklenemedi.',
            isLoadingMore: false,
          },
        }));
      }
    },
    [client],
  );

  const loadMessagesNextPage = useCallback(
    async (query: MessageQuery) => {
      const scope: MessageScope =
        query.folder === PINNED_FOLDER
          ? { kind: 'pinned' }
          : { kind: 'folder', folderId: query.folder };
      const key = messageListKey(query.accountId, scope, query.filter);

      const current = latestMessageLists.current[key];
      if (!current || !current.hasMore || current.isLoadingMore || !current.nextCursor) {
        return;
      }

      setMessageLists((prev) => ({
        ...prev,
        [key]: {
          ...prev[key],
          isLoadingMore: true,
        },
      }));

      try {
        const page = await messagesApi.listMessages(client, query.accountId, {
          scope,
          filter: query.filter,
          cursor: current.nextCursor,
          limit: PAGE_SIZE,
        });

        if (!pageMatchesRequest(page, { accountId: query.accountId, scope })) {
          return;
        }

        for (const item of page.items) {
          messagesById.current.set(item.id, item);
        }

        setMessageLists((prev) => {
          const prevEntry = prev[key];
          if (!prevEntry) return prev;
          const existingIds = new Set(prevEntry.items.map((m) => m.id));
          const uniqueNew = page.items.filter((m) => !existingIds.has(m.id));

          return {
            ...prev,
            [key]: {
              items: [...prevEntry.items, ...uniqueNew],
              nextCursor: page.nextCursor,
              hasMore: page.nextCursor !== null,
              status: 'ready',
              isLoadingMore: false,
            },
          };
        });
      } catch {
        setMessageLists((prev) => ({
          ...prev,
          [key]: {
            ...prev[key],
            isLoadingMore: false,
          },
        }));
      }
    },
    [client],
  );

  const applyActions = useCallback(
    async (
      ids: string[],
      actionBuilder: (m: MessageSummary) => MessageAction[],
    ): Promise<UndoHandle | null> => {
      if (ids.length === 0) return null;

      // Identify accountId and gather message summaries
      const targetMessages: MessageSummary[] = [];
      let accountId = '';
      for (const id of ids) {
        const found = messagesById.current.get(id);
        if (found) {
          targetMessages.push(found);
          if (!accountId) accountId = found.accountId;
        }
      }

      if (!accountId) {
        // Fallback to first available account
        if (accounts.status === 'ready' && accounts.data[0]) {
          accountId = accounts.data[0].id;
        } else {
          return null;
        }
      }

      // Build ActionContext
      const currentFolders = latestFolders.current[accountId];
      const currentLabels = latestLabels.current[accountId];
      const actionContext: ActionContext = {
        folders: currentFolders?.status === 'ready' ? currentFolders.data : [],
        labels: currentLabels?.status === 'ready' ? currentLabels.data : [],
      };

      // Calculate optimistic predictions and save snapshots for rollback
      const snapshots = new Map<string, MessageSummary>();
      const optimisticUpdates = new Map<string, MessageSummary | null>(); // null = deleted/removed from view
      const firstMessage = targetMessages[0];
      const actionsToSend = firstMessage ? actionBuilder(firstMessage) : [];

      for (const m of targetMessages) {
        snapshots.set(m.id, m);
        const outcome = predictActions(m, actionBuilder(m), actionContext);
        switch (outcome.kind) {
          case 'rejected':
            break;
          case 'deleted':
            optimisticUpdates.set(m.id, null);
            break;
          case 'updated':
            optimisticUpdates.set(m.id, outcome.message);
            break;
          case 'moved':
            // If moved to another folder, remove from current folder list
            optimisticUpdates.set(m.id, null);
            break;
        }
      }

      // Apply optimistic update to all active message lists and pinned messages
      const applyMapToItems = (list: MessageSummary[]) => {
        const result: MessageSummary[] = [];
        for (const item of list) {
          if (!optimisticUpdates.has(item.id)) {
            result.push(item);
          } else {
            const updated = optimisticUpdates.get(item.id);
            if (updated !== null && updated !== undefined) {
              result.push(updated);
            }
          }
        }
        return result;
      };

      setMessageLists((prev) => {
        const next: CacheState['messageLists'] = {};
        for (const [key, val] of Object.entries(prev)) {
          next[key] = {
            ...val,
            items: applyMapToItems(val.items),
          };
        }
        return next;
      });

      setPinnedByAccount((prev) => {
        const currentPinned = prev[accountId] ?? [];
        return {
          ...prev,
          [accountId]: applyMapToItems(currentPinned),
        };
      });

      // Update message detail cache optimistically
      setMessagesDetail((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [key, entry] of Object.entries(prev)) {
          if (entry.status !== 'ready') continue;
          const msg = entry.data;
          if (optimisticUpdates.has(msg.id)) {
            const updated = optimisticUpdates.get(msg.id);
            if (updated) {
              next[key] = {
                status: 'ready',
                data: {
                  ...msg,
                  seen: updated.seen,
                  pinned: updated.pinned,
                  answered: updated.answered,
                  forwarded: updated.forwarded,
                  labels: updated.labels,
                  folderId: updated.folderId,
                },
              };
              changed = true;
            }
          }
        }
        return changed ? next : prev;
      });

      // Update registry
      for (const [id, updated] of optimisticUpdates.entries()) {
        if (updated) {
          messagesById.current.set(id, updated);
        }
      }

      // Rollback function
      const rollback = (failedIds: Set<string>) => {
        const revertToSnapshots = (list: MessageSummary[]) => {
          const map = new Map(list.map((m) => [m.id, m]));
          for (const fid of failedIds) {
            const original = snapshots.get(fid);
            if (original) {
              map.set(fid, original);
            }
          }
          return Array.from(map.values());
        };

        setMessageLists((prev) => {
          const next: CacheState['messageLists'] = {};
          for (const [key, val] of Object.entries(prev)) {
            next[key] = {
              ...val,
              items: revertToSnapshots(val.items),
            };
          }
          return next;
        });

        setPinnedByAccount((prev) => {
          const currentPinned = prev[accountId] ?? [];
          return {
            ...prev,
            [accountId]: revertToSnapshots(currentPinned),
          };
        });

        for (const fid of failedIds) {
          const original = snapshots.get(fid);
          if (original) {
            messagesById.current.set(fid, original);
          }
        }
      };

      try {
        const response = await actionsApi.applyMessageActions(client, {
          accountId,
          messageIds: ids,
          actions: actionsToSend,
        });

        // Reconcile failed items
        if (response.failed && response.failed.length > 0) {
          const failedIds = new Set(response.failed.map((f) => f.messageId));
          rollback(failedIds);
        }

        // Trigger folder refresh to update unread counts
        void loadFolders(accountId);
        void loadPinned(accountId);

        // If undo is available, return UndoHandle
        if (response.undo) {
          const undoToken = response.undo.token;
          return {
            undo: async () => {
              try {
                const undoRes = await actionsApi.undoAction(client, undoToken);
                if (undoRes.restored) {
                  rollback(new Set(ids));
                  void loadFolders(accountId);
                  void loadPinned(accountId);
                  return true;
                }
                return false;
              } catch {
                return false;
              }
            },
          };
        }

        return null;
      } catch {
        // Rollback all on request failure
        rollback(new Set(ids));
        return null;
      }
    },
    [client, accounts, loadFolders, loadPinned],
  );

  const actions = useMemo<MailActions>(() => {
    const same = (...list: MessageAction[]) => () => list;

    return {
      setSeen: (ids, seen) =>
        void applyActions(ids, same({ type: seen ? 'markRead' : 'markUnread' })),
      setPinned: (ids, pinned) =>
        void applyActions(ids, same({ type: pinned ? 'pin' : 'unpin' })),
      archive: (ids) => {
        let handle: UndoHandle | null = null;
        void applyActions(ids, same({ type: 'archive' })).then((h) => {
          handle = h;
        });
        return {
          undo: async () => {
            if (handle) return handle.undo();
            return false;
          },
        };
      },
      remove: (ids) => {
        let handle: UndoHandle | null = null;
        void applyActions(ids, same({ type: 'delete' })).then((h) => {
          handle = h;
        });
        return {
          undo: async () => {
            if (handle) return handle.undo();
            return false;
          },
        };
      },
      restoreToInbox: (ids) => {
        let handle: UndoHandle | null = null;
        void applyActions(ids, same({ type: 'restore' })).then((h) => {
          handle = h;
        });
        return {
          undo: async () => {
            if (handle) return handle.undo();
            return false;
          },
        };
      },
      markSpam: (ids) => {
        let handle: UndoHandle | null = null;
        void applyActions(ids, same({ type: 'spam' })).then((h) => {
          handle = h;
        });
        return {
          undo: async () => {
            if (handle) return handle.undo();
            return false;
          },
        };
      },
      moveToFolder: (ids, folderId) => {
        let handle: UndoHandle | null = null;
        void applyActions(ids, same({ type: 'move', folderId })).then((h) => {
          handle = h;
        });
        return {
          undo: async () => {
            if (handle) return handle.undo();
            return false;
          },
        };
      },
      deletePermanently: (ids) =>
        void applyActions(ids, same({ type: 'deletePermanently', confirmed: true })),
      applyLabel: (ids, labelNameOrId) => {
        // Resolve label ID from name if needed
        let resolvedLabelId = labelNameOrId;
        const firstMessage = ids[0] ? messagesById.current.get(ids[0]) : undefined;
        if (firstMessage) {
          const accountLabels = latestLabels.current[firstMessage.accountId];
          if (accountLabels?.status === 'ready') {
            const found = accountLabels.data.find(
              (l) => l.name === labelNameOrId || l.id === labelNameOrId,
            );
            if (found) resolvedLabelId = found.id;
          }
        }
        void applyActions(ids, () => [{ type: 'label', labelId: resolvedLabelId, mode: 'add' }]);
      },
    };
  }, [applyActions]);

  const source = useMemo<MailDataSource>(
    () => ({
      useAccounts: () => {
        const { state, loadAccounts } = useStore();
        useEffect(() => {
          if (state.accounts.status !== 'ready') {
            void loadAccounts();
          }
        }, [state.accounts.status, loadAccounts]);
        return state.accounts;
      },

      reloadAccounts: async () => {
        await loadAccounts();
      },

      useFolders: (accountId: string) => {
        const { state, loadFolders } = useStore();
        const current = state.foldersByAccount[accountId];
        useEffect(() => {
          if (accountId) {
            void loadFolders(accountId);
          }
        }, [accountId, loadFolders]);
        return current ?? { status: 'loading' };
      },

      useLabels: (accountId: string) => {
        const { state, loadLabels } = useStore();
        const current = state.labelsByAccount[accountId];
        useEffect(() => {
          if (accountId) {
            void loadLabels(accountId);
          }
        }, [accountId, loadLabels]);
        return current ?? { status: 'loading' };
      },

      usePinnedCount: (accountId: string) => {
        const { state, loadPinned } = useStore();
        const pinned = state.pinnedByAccount[accountId];
        useEffect(() => {
          if (accountId) {
            void loadPinned(accountId);
          }
        }, [accountId, loadPinned]);
        return pinned ? pinned.length : 0;
      },

      usePinned: (accountId: string) => {
        const { state, loadPinned } = useStore();
        const pinned = state.pinnedByAccount[accountId];
        useEffect(() => {
          if (accountId) {
            void loadPinned(accountId);
          }
        }, [accountId, loadPinned]);
        return pinned ? sortByDateDesc(pinned) : [];
      },

      useMessages: (query: MessageQuery): Loadable<MessagePage> => {
        const { state, loadMessagesFirstPage, loadMessagesNextPage } = useStore();
        const scope: MessageScope =
          query.folder === PINNED_FOLDER
            ? { kind: 'pinned' }
            : { kind: 'folder', folderId: query.folder };
        const key = messageListKey(query.accountId, scope, query.filter);
        const entry = state.messageLists[key];

        useEffect(() => {
          if (!query.accountId || !query.folder) return;
          const controller = new AbortController();
          void loadMessagesFirstPage(query, controller.signal);
          return () => {
            controller.abort();
          };
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [key, query.accountId, query.folder, isFilterActive(query.filter)]);

        const loadMore = useCallback(() => {
          void loadMessagesNextPage(query);
        }, [query, loadMessagesNextPage]);

        if (!entry || entry.status === 'loading') {
          return { status: 'loading' };
        }

        if (entry.status === 'error') {
          return {
            status: 'error',
            message: entry.errorMessage ?? 'İletiler yüklenemedi.',
          };
        }

        return {
          status: 'ready',
          data: {
            items: entry.items,
            hasMore: entry.hasMore,
            isLoadingMore: entry.isLoadingMore,
            loadMore,
          },
        };
      },

      useMessageDetail: (accountId: string, messageId: string): Loadable<MessageDTO> => {
        const { state, loadMessageDetail } = useStore();
        const key = `${accountId}:${messageId}`;
        const current = state.messagesDetail[key];

        useEffect(() => {
          if (!accountId || !messageId) return;
          if (current?.status === 'ready') return;
          const controller = new AbortController();
          void loadMessageDetail(accountId, messageId, controller.signal);
          return () => {
            controller.abort();
          };
        }, [accountId, messageId, loadMessageDetail, current?.status]);

        return current ?? { status: 'loading' };
      },

      actions,
    }),
    [actions, loadAccounts],
  );

  const storeValue = useMemo<StoreContextValue>(
    () => ({
      state: {
        accounts,
        foldersByAccount,
        labelsByAccount,
        pinnedByAccount,
        messagesDetail,
        messageLists,
      },
      client,
      loadAccounts,
      loadFolders,
      loadLabels,
      loadPinned,
      loadMessagesFirstPage,
      loadMessagesNextPage,
      loadMessageDetail,
      applyActions,
    }),
    [
      accounts,
      foldersByAccount,
      labelsByAccount,
      pinnedByAccount,
      messagesDetail,
      messageLists,
      client,
      loadAccounts,
      loadFolders,
      loadLabels,
      loadPinned,
      loadMessagesFirstPage,
      loadMessagesNextPage,
      loadMessageDetail,
      applyActions,
    ],
  );

  return (
    <StoreContext.Provider value={storeValue}>
      <MailDataProvider source={source}>{children}</MailDataProvider>
    </StoreContext.Provider>
  );
}

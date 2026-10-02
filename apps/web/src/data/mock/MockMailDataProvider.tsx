/**
 * MOCK implementation of `MailDataSource`. Holds messages in memory (shaped as the shared API DTOs from
 * `@kaydet/domain`) so the shell's actions, undo and states are demonstrable. Business rules are NOT
 * re-implemented here: folder tree, filter/sort and the effect of every action come from the domain
 * package, exactly as the real API-backed source will get them from the server. Only the fixture data
 * and the in-memory store are mock, and this file is replaced wholesale when the real API lands.
 *
 * Dev scenarios (query param): `?mock=loading` (skeleton forever), `?mock=empty`, `?mock=error`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  applyMessageFilter,
  buildFolderTree,
  folderDisplayName,
  folderSortOrder,
  predictActions,
  sortByDateDesc,
} from '@kaydet/domain';
import type { ActionContext, MessageAction } from '@kaydet/domain';
import { MailDataProvider } from '../MailDataContext';
import { PINNED_FOLDER } from '../types';
import type {
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
import { MOCK_ACCOUNTS, MOCK_FOLDER_SPECS, MOCK_LABELS, generateMessages } from './mockData';
import type { MockFolderSpec } from './mockData';

const PAGE = 30;
type Scenario = 'normal' | 'loading' | 'empty' | 'error';

const folderId = (accountId: string, key: string): string => `${accountId}_${key}`;
const labelId = (accountId: string, name: string): string => `${accountId}:label:${name}`;

function buildMessages(now: number): MessageSummary[] {
  const all: MessageSummary[] = [];
  MOCK_ACCOUNTS.forEach((account, a) => {
    MOCK_FOLDER_SPECS.forEach((spec, s) => {
      const count = a === 0 ? spec.count : Math.max(2, Math.round(spec.count / 3));
      all.push(
        ...generateMessages({
          accountId: account.id,
          folderId: folderId(account.id, spec.key),
          role: spec.role,
          count,
          seed: 1000 * (a + 1) + s,
          now,
        }),
      );
    });
  });
  return all;
}

/** Server-side path of a mock folder (custom sub-folders nest under their parent, `/` delimiter). */
function specPath(spec: MockFolderSpec): string {
  const parent = spec.parent ? MOCK_FOLDER_SPECS.find((s) => s.key === spec.parent) : undefined;
  return parent ? `${specPath(parent)}/${spec.name}` : spec.name;
}

/** The folder list of an account in tree order, built by the domain's `buildFolderTree`. */
function folderTree(accountId: string) {
  return buildFolderTree(
    MOCK_FOLDER_SPECS.map((spec) => ({
      id: folderId(accountId, spec.key),
      accountId,
      path: specPath(spec),
      delimiter: '/',
      role: spec.role,
      name: folderDisplayName(spec.role, spec.name),
      sortOrder: folderSortOrder(spec.role),
      favorite: spec.favorite === true,
    })),
  );
}

/** What the domain's action prediction needs to know: every folder and label of every account. */
const ACTION_CONTEXT: ActionContext = {
  folders: MOCK_ACCOUNTS.flatMap((a) =>
    MOCK_FOLDER_SPECS.map((spec) => ({ id: folderId(a.id, spec.key), accountId: a.id, role: spec.role })),
  ),
  labels: MOCK_ACCOUNTS.flatMap((a) => MOCK_LABELS.map((l) => ({ id: labelId(a.id, l.name), accountId: a.id, name: l.name }))),
};

interface Store {
  messages: MessageSummary[];
  scenario: Scenario;
}
const StoreContext = createContext<Store | null>(null);
const useStore = (): Store => {
  const store = useContext(StoreContext);
  if (!store) throw new Error('MockMailDataProvider is missing');
  return store;
};

function readScenario(): Scenario {
  const value = new URLSearchParams(window.location.search).get('mock');
  return value === 'loading' || value === 'empty' || value === 'error' ? value : 'normal';
}

function useMockMessages(query: MessageQuery): Loadable<MessagePage> {
  const { messages, scenario } = useStore();
  const key = `${query.accountId}|${query.folder}`;
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [warm, setWarm] = useState<ReadonlySet<string>>(() => new Set());

  // Simulate the first sync of a folder so the skeleton state is visible (mobile: cold folder).
  useEffect(() => {
    if (scenario === 'loading' || scenario === 'error' || warm.has(key)) return;
    const timer = window.setTimeout(() => setWarm((prev) => new Set(prev).add(key)), 450);
    return () => window.clearTimeout(timer);
  }, [key, scenario, warm]);

  const limit = limits[key] ?? PAGE;
  const loadMore = useCallback(() => setLimits((prev) => ({ ...prev, [key]: (prev[key] ?? PAGE) + PAGE })), [key]);

  const { filter } = query;
  const result = useMemo(() => {
    const inFolder = messages.filter(
      (m) =>
        m.accountId === query.accountId &&
        (query.folder === PINNED_FOLDER ? m.pinned : m.folderId === query.folder),
    );
    const sorted = applyMessageFilter(inFolder, filter);
    return { items: sorted.slice(0, limit), hasMore: sorted.length > limit };
  }, [messages, query.accountId, query.folder, filter, limit]);

  if (scenario === 'loading') return { status: 'loading' };
  if (scenario === 'error') return { status: 'error', message: 'Sunucuya ulaşılamıyor.' };
  if (!warm.has(key)) return { status: 'loading' };
  const items = scenario === 'empty' ? [] : result.items;
  return {
    status: 'ready',
    data: { items, hasMore: scenario === 'empty' ? false : result.hasMore, isLoadingMore: false, loadMore },
  };
}

export function MockMailDataProvider({ children }: { children: ReactNode }) {
  const [now] = useState(() => Date.now());
  const [scenario] = useState<Scenario>(readScenario);
  const [messages, setMessages] = useState<MessageSummary[]>(() => buildMessages(now));

  const latest = useRef(messages);
  useEffect(() => {
    latest.current = messages;
  }, [messages]);

  const actions = useMemo<MailActions>(() => {
    /** Publishes a new list and keeps the ref current, so consecutive actions in one event see each other. */
    const commit = (next: MessageSummary[]) => {
      latest.current = next;
      setMessages(next);
    };

    /**
     * Applies contract actions to messages using the domain's predicted outcome (the same thing the server
     * will do). Returns an undo handle when messages were relocated, like the API's undo token.
     */
    const apply = (ids: string[], actionsFor: (m: MessageSummary) => MessageAction[]): UndoHandle | null => {
      const set = new Set(ids);
      const relocated = new Map<string, MessageSummary>();
      const next: MessageSummary[] = [];
      for (const m of latest.current) {
        if (!set.has(m.id)) {
          next.push(m);
          continue;
        }
        const outcome = predictActions(m, actionsFor(m), ACTION_CONTEXT);
        switch (outcome.kind) {
          case 'rejected':
            next.push(m); // the server would refuse; nothing changes
            break;
          case 'deleted':
            break; // irreversible
          case 'updated':
            next.push(outcome.message);
            break;
          case 'moved':
            relocated.set(m.id, m);
            if (outcome.toFolderId !== null) next.push(outcome.message); // unknown target: just hide the row
            break;
        }
      }
      commit(next);
      if (relocated.size === 0) return null;
      return {
        undo: () => {
          commit([...latest.current.filter((m) => !relocated.has(m.id)), ...relocated.values()]);
          return Promise.resolve(true);
        },
      };
    };
    const same = (...list: MessageAction[]) => () => list;

    return {
      setSeen: (ids, seen) => void apply(ids, same({ type: seen ? 'markRead' : 'markUnread' })),
      setPinned: (ids, pinned) => void apply(ids, same({ type: pinned ? 'pin' : 'unpin' })),
      archive: (ids) => apply(ids, same({ type: 'archive' })),
      remove: (ids) => apply(ids, same({ type: 'delete' })),
      restoreToInbox: (ids) => apply(ids, same({ type: 'restore' })),
      markSpam: (ids) => apply(ids, same({ type: 'spam' })),
      moveToFolder: (ids, target) => apply(ids, same({ type: 'move', folderId: target })),
      deletePermanently: (ids) => void apply(ids, same({ type: 'deletePermanently', confirmed: true })),
      applyLabel: (ids, labelName) =>
        void apply(ids, (m) => [{ type: 'label', labelId: labelId(m.accountId, labelName), mode: 'add' }]),
    };
  }, []);

  const source = useMemo<MailDataSource>(
    () => ({
      useAccounts: () => ({ status: 'ready', data: MOCK_ACCOUNTS }),
      useFolders: (accountId) => {
        const { messages: all } = useStore();
        return useMemo(() => {
          const data: FolderView[] = folderTree(accountId).map(({ folder, depth, parentId, hasChildren }) => {
            const inFolder = all.filter((m) => m.folderId === folder.id);
            return {
              id: folder.id,
              accountId,
              name: folder.name,
              role: folder.role,
              parentId,
              depth,
              hasChildren,
              isFavorite: folder.favorite,
              unreadCount: inFolder.filter((m) => !m.seen && !m.draft).length,
              totalCount: inFolder.length,
            };
          });
          return { status: 'ready', data } as const;
        }, [all, accountId]);
      },
      useLabels: (accountId) =>
        useMemo<Loadable<LabelView[]>>(
          () => ({
            status: 'ready',
            data: MOCK_LABELS.map((l) => ({ ...l, id: labelId(accountId, l.name), accountId })),
          }),
          [accountId],
        ),
      usePinnedCount: (accountId) => {
        const { messages: all, scenario } = useStore();
        return useMemo(
          () => (scenario === 'empty' ? 0 : all.filter((m) => m.accountId === accountId && m.pinned).length),
          [all, accountId, scenario],
        );
      },
      usePinned: (accountId) => {
        const { messages: all, scenario } = useStore();
        return useMemo(
          () => (scenario === 'empty' ? [] : sortByDateDesc(all.filter((m) => m.accountId === accountId && m.pinned))),
          [all, accountId, scenario],
        );
      },
      useMessages: useMockMessages,
      useMessageDetail: (accountId, messageId) => {
        const { messages: all, scenario } = useStore();
        return useMemo<Loadable<MessageDTO>>(() => {
          if (scenario === 'loading') return { status: 'loading' };
          if (scenario === 'error') return { status: 'error', message: 'İleti yüklenemedi.' };
          const found = all.find((m) => m.accountId === accountId && m.id === messageId);
          if (!found) return { status: 'error', message: 'İleti bulunamadı.' };
          const dto: MessageDTO = {
            ...found,
            cc: [],
            bcc: [],
            body: {
              text: found.preview,
              html: {
                content: `<p>${found.preview}</p>`,
                sanitized: true,
              },
            },
            attachments: found.hasAttachments
              ? [
                  {
                    id: `att-${found.id}`,
                    messageId: found.id,
                    fileName: 'belge.pdf',
                    mimeType: 'application/pdf',
                    sizeBytes: 1024 * 1024 * 1.5,
                    isInline: false,
                  },
                ]
              : [],
          };
          return { status: 'ready', data: dto };
        }, [all, accountId, messageId, scenario]);
      },
      actions,
    }),
    [actions],
  );

  const store = useMemo(() => ({ messages, scenario }), [messages, scenario]);
  return (
    <StoreContext.Provider value={store}>
      <MailDataProvider source={source}>{children}</MailDataProvider>
    </StoreContext.Provider>
  );
}

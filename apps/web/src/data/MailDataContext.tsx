import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
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
} from './types';

const MailDataContext = createContext<MailDataSource | null>(null);

/** Supplies the data source (mock now; API-backed later). Wired once in `app/providers.tsx`. */
export function MailDataProvider({ source, children }: { source: MailDataSource; children: ReactNode }) {
  return <MailDataContext.Provider value={source}>{children}</MailDataContext.Provider>;
}

function useSource(): MailDataSource {
  const source = useContext(MailDataContext);
  if (!source) throw new Error('MailDataProvider is missing');
  return source;
}

// Thin hook facade: features import these, never the source directly.
export const useAccounts = (): Loadable<AccountView[]> => useSource().useAccounts();
export const useFolders = (accountId: string): Loadable<FolderView[]> => useSource().useFolders(accountId);
export const useLabels = (accountId: string): Loadable<LabelView[]> => useSource().useLabels(accountId);
export const usePinnedCount = (accountId: string): number => useSource().usePinnedCount(accountId);
export const usePinnedMessages = (accountId: string): MessageSummary[] => useSource().usePinned(accountId);
export const useMessages = (query: MessageQuery): Loadable<MessagePage> => useSource().useMessages(query);
export const useMessageDetail = (accountId: string, messageId: string): Loadable<MessageDTO> =>
  useSource().useMessageDetail(accountId, messageId);
export const useMailActions = (): MailActions => useSource().actions;
export const useReloadAccounts = (): (() => Promise<void>) => {
  const source = useSource();
  return source.reloadAccounts ?? (() => Promise.resolve());
};

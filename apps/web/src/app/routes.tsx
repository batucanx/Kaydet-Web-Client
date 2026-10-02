import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { useAccounts, useFolders } from '../data/MailDataContext';
import { ComposePage } from '../features/compose/ComposePage';
import { MailListPage } from '../features/mail-list/MailListPage';
import { SearchPage } from '../features/search/SearchPage';
import { InitialAccountSetupPage } from '../features/account-setup';
import { AppShell } from '../shell/AppShell';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { Inbox } from 'lucide-react';

/** `/` → the first account. (Real auth: no account ⇒ add account onboarding screen.) */
function RootRedirect() {
  const accounts = useAccounts();
  if (accounts.status !== 'ready') return <Skeleton height={4} />;
  const first = accounts.data[0];
  if (first) {
    return <Navigate to={`/a/${first.id}`} replace />;
  }
  return <Navigate to="/accounts/add" replace />;
}

/** `/a/:accountId` → that account's Inbox (mobile: switching account opens its Inbox). */
function DefaultFolder() {
  const { accountId = '' } = useParams();
  const { search } = useLocation();
  const folders = useFolders(accountId);
  if (folders.status !== 'ready') return <Skeleton height={4} />;
  const inbox = folders.data.find((f) => f.role === 'inbox') ?? folders.data[0];
  return inbox ? (
    <Navigate to={{ pathname: `/a/${accountId}/f/${inbox.id}`, search }} replace />
  ) : (
    <EmptyState icon={Inbox} title="Klasör yok" />
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/accounts/add" element={<InitialAccountSetupPage />} />
      <Route path="/a/:accountId" element={<AppShell />}>
        <Route index element={<DefaultFolder />} />
        <Route path="compose" element={<ComposePage />} />
        <Route path="compose/:draftId" element={<ComposePage />} />
        <Route path="search/*" element={<SearchPage />} />
        {/* `*` carries the optional `m/:messageId` so the list stays mounted while a message opens. */}
        <Route path="f/:folderRef/*" element={<MailListPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

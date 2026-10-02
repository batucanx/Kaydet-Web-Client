import { SquarePen } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Outlet, useNavigate, useParams } from 'react-router-dom';
import { useAccounts } from '../data/MailDataContext';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { ServerCrash } from 'lucide-react';
import styles from './AppShell.module.css';
import { ShellContext } from './ShellContext';
import type { ShellContextValue } from './ShellContext';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useShellMode } from './useShellMode';

/**
 * Application shell: skip link · top bar · sidebar · main (routed content).
 * Route: `/a/:accountId/...` — the active account is URL state, so the shell is multi-account
 * and multi-tab safe from the start. Data comes only through the `MailDataSource` port.
 */
export function AppShell() {
  const { accountId = '' } = useParams();
  const navigate = useNavigate();
  const accounts = useAccounts();
  const mode = useShellMode();
  const [drawerRequested, setDrawerRequested] = useState(false);

  const drawerOpen = drawerRequested && mode === 'mobile';
  const openDrawer = useCallback(() => setDrawerRequested(true), []);
  const closeDrawer = useCallback(() => setDrawerRequested(false), []);

  // Return focus to the menu button after the drawer closes.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !drawerOpen) {
      document.querySelector<HTMLElement>('[data-drawer-opener]')?.focus();
    }
    wasOpen.current = drawerOpen;
  }, [drawerOpen]);

  const ctx = useMemo<ShellContextValue>(
    () => ({ mode, drawerOpen, openDrawer, closeDrawer }),
    [mode, drawerOpen, openDrawer, closeDrawer],
  );

  if (accounts.status === 'loading') {
    return (
      <div className={styles.splash} role="status" aria-label="Yükleniyor">
        <span className={styles.splashWord}>Kaydet</span>
        <Skeleton width={120} height={4} />
      </div>
    );
  }
  if (accounts.status === 'error') {
    return <EmptyState role="alert" icon={ServerCrash} title="Uygulama başlatılamadı" description={accounts.message} />;
  }

  const active = accounts.data.find((a) => a.id === accountId);
  if (!active) {
    const first = accounts.data[0];
    return first ? <Navigate to={`/a/${first.id}`} replace /> : <EmptyState icon={ServerCrash} title="Hesap yok" />;
  }

  return (
    <ShellContext.Provider value={ctx}>
      <div className={styles.shell} data-shell={mode}>
        <a href="#main" className={styles.skip}>
          Ana içeriğe geç
        </a>
        <div className={styles.topWrap} inert={drawerOpen}>
          <TopBar accounts={accounts.data} activeAccountId={active.id} />
        </div>
        <Sidebar accountId={active.id} />
        <main id="main" tabIndex={-1} className={styles.main} inert={drawerOpen}>
          <Outlet />
        </main>
        {mode === 'mobile' && (
          <button
            type="button"
            className={styles.fab}
            inert={drawerOpen}
            onClick={() => navigate(`/a/${active.id}/compose`)}
          >
            <SquarePen size={20} aria-hidden="true" />
            <span>Yeni ileti</span>
          </button>
        )}
      </div>
    </ShellContext.Provider>
  );
}

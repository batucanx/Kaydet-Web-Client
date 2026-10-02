import { Menu as MenuIcon, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { AccountView } from '../data/types';
import { IconButton } from '../ui/IconButton';
import { AccountSwitcher } from './AccountSwitcher';
import { SearchBar } from './SearchBar';
import { useShell } from './ShellContext';
import { ThemeToggle } from './ThemeToggle';
import styles from './TopBar.module.css';

interface TopBarProps {
  accounts: AccountView[];
  activeAccountId: string;
}

/** Top bar (`<header>`): identity · search · theme · account. mobile: `_InboxAppBar` (56 px). */
export function TopBar({ accounts, activeAccountId }: TopBarProps) {
  const { mode, openDrawer } = useShell();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [searchOpen, setSearchOpen] = useState(false);
  const isMobile = mode === 'mobile';
  const showName = mode === 'laptop' || mode === 'desktop' || mode === 'wide';

  const isSearchPage = location.pathname.includes('/search');
  const currentQuery = isSearchPage ? (searchParams.get('q') ?? '') : '';

  const submit = (query: string) => {
    if (isMobile) setSearchOpen(false);
    navigate(`/a/${activeAccountId}/search?q=${encodeURIComponent(query)}`);
  };

  return (
    <header className={styles.bar}>
      {isMobile && searchOpen ? (
        <div className={styles.mobileSearch}>
          <SearchBar
            focusOnMount
            initialValue={currentQuery}
            showShortcutHint={false}
            onSubmit={submit}
            onClose={() => setSearchOpen(false)}
          />
          <button type="button" className={styles.cancel} onClick={() => setSearchOpen(false)}>
            Vazgeç
          </button>
        </div>
      ) : (
        <>
          {isMobile && (
            <IconButton
              icon={MenuIcon}
              label="Klasörleri göster"
              tone="onAppBar"
              onClick={openDrawer}
              data-drawer-opener=""
            />
          )}
          <Link to="/" className={styles.brand} aria-label="Kaydet — ana sayfa">
            <img src="/brand/kaydet-96.png" alt="" width={28} height={28} className={styles.logo} />
            <span className={styles.wordmark}>Kaydet</span>
          </Link>
          <div className={styles.search}>
            {isMobile ? null : <SearchBar initialValue={currentQuery} onSubmit={submit} />}
          </div>
          <div className={styles.actions}>
            {isMobile && <IconButton icon={Search} label="Ara" tone="onAppBar" onClick={() => setSearchOpen(true)} />}
            <ThemeToggle />
            <AccountSwitcher accounts={accounts} activeAccountId={activeAccountId} showName={showName} />
          </div>
        </>
      )}
    </header>
  );
}

import { useState } from 'react';
import { Check, ChevronDown, LogOut, UserPlus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import type { AccountView } from '../data/types';
import { AddAccountModal } from '../features/account-setup';
import { Avatar } from '../ui/Avatar';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../ui/Menu';
import styles from './AccountSwitcher.module.css';

interface AccountSwitcherProps {
  accounts: AccountView[];
  activeAccountId: string;
  /** Show name + address next to the avatar (hidden in compact layouts). */
  showName: boolean;
}

const nameOf = (a: AccountView): string => a.displayName || a.email;

/**
 * Account switcher. The active account is the `:accountId` URL segment (never server state), so
 * tabs are independent and links are shareable. Switching returns to that account's Inbox,
 * as on mobile (`_selectAccountAndOpenInbox`).
 */
export function AccountSwitcher({ accounts, activeAccountId, showName }: AccountSwitcherProps) {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [isAddAccountOpen, setIsAddAccountOpen] = useState(false);
  const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0];
  if (!active) return null;

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className={styles.trigger} aria-label={`Hesap: ${nameOf(active)}. Hesap değiştir`}>
            <Avatar name={active.displayName} email={active.email} size={32} />
            {showName && (
              <span className={styles.text}>
                <span className={styles.name}>{nameOf(active)}</span>
                {active.displayName && <span className={styles.email}>{active.email}</span>}
              </span>
            )}
            <ChevronDown size={16} aria-hidden="true" className={styles.chevron} />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuLabel>Hesaplar</MenuLabel>
          {accounts.map((account) => (
            <MenuItem
              key={account.id}
              leading={<Avatar name={account.displayName} email={account.email} size={28} />}
              meta={account.id === active.id ? <Check size={16} aria-label="Etkin hesap" /> : undefined}
              onSelect={() => navigate(`/a/${account.id}`)}
            >
              <span className={styles.itemName}>{nameOf(account)}</span>
              {account.displayName && <span className={styles.itemEmail}>{account.email}</span>}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem icon={UserPlus} onSelect={() => setIsAddAccountOpen(true)}>
            Hesap ekle
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={LogOut} onSelect={() => void logout()}>
            Çıkış yap
          </MenuItem>
        </MenuContent>
      </Menu>

      <AddAccountModal
        open={isAddAccountOpen}
        onClose={() => setIsAddAccountOpen(false)}
      />
    </>
  );
}

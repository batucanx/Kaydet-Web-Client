import { useNavigate } from 'react-router-dom';
import type { AccountDTO } from '@kaydet/domain';
import { useAccounts } from '../../data/MailDataContext';
import { useAuth } from '../../auth/AuthContext';
import { AccountSetupForm } from './AccountSetupForm';
import styles from './InitialAccountSetupPage.module.css';

export interface InitialAccountSetupPageProps {
  onSuccess?: (account: AccountDTO) => void;
}

export function InitialAccountSetupPage({ onSuccess }: InitialAccountSetupPageProps) {
  const accounts = useAccounts();
  const { logout } = useAuth();
  const navigate = useNavigate();

  const hasExistingAccounts = accounts.status === 'ready' && accounts.data.length > 0;

  const handleCancel = () => {
    if (hasExistingAccounts) {
      navigate(-1);
    } else {
      void logout();
    }
  };

  return (
    <div className={styles.container}>
      <main className={styles.card}>
        <div className={styles.header}>
          <span className={styles.logo}>Kaydet</span>
          <h1 className={styles.title}>Hesap Ekle</h1>
          <p className={styles.subtitle}>E-postalarınıza erişmek için IMAP/SMTP hesabınızı bağlayın</p>
        </div>

        <AccountSetupForm
          onSuccess={onSuccess}
          onCancel={handleCancel}
          cancelLabel={hasExistingAccounts ? 'Vazgeç' : 'Çıkış Yap'}
          submitLabel="Hesap Ekle"
        />
      </main>
    </div>
  );
}

/** Alias for route compatibility */
export const AddAccountPage = InitialAccountSetupPage;

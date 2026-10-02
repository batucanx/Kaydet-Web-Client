import { useState } from 'react';
import type { FormEvent } from 'react';
import { AlertCircle } from 'lucide-react';
import { useAuth } from './AuthContext';
import { ApiClientError } from '../data/api/errors';
import { MailboxFields } from '../features/account-setup/MailboxFields';
import { useMailboxFields } from '../features/account-setup/useMailboxFields';
import { Button } from '../ui/Button';
import styles from './LoginPage.module.css';

export function LoginPage() {
  const { login } = useAuth();
  const fields = useMailboxFields();
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const checked = fields.validate();
    if (!checked.ok) {
      setErrorMessage(checked.message);
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      await login(checked.value);
    } catch (err) {
      if (err instanceof ApiClientError) {
        const hasImapError = err.fields?.some((f) => f.field === 'imap');
        const hasSmtpError = err.fields?.some((f) => f.field === 'smtp');
        fields.setShowAdvanced(true);
        if (hasImapError) {
          setErrorMessage(`Gelen sunucu (IMAP): ${err.userMessage}`);
        } else if (hasSmtpError) {
          setErrorMessage(`Giden sunucu (SMTP): ${err.userMessage}`);
        } else {
          setErrorMessage(err.userMessage);
        }
      } else {
        setErrorMessage('Giriş yapılamadı. Lütfen bağlantı ayarlarını kontrol edip tekrar deneyin.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <main className={styles.card}>
        <div className={styles.brand}>
          <img src="/brand/kaydet-192.png" alt="Kaydet" width={72} height={72} className={styles.logo} />
          <span className={styles.subtitle}>E-postalarınıza erişmek için oturum açın</span>
        </div>

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          {errorMessage && (
            <div className={styles.errorAlert} role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{errorMessage}</span>
            </div>
          )}

          <MailboxFields fields={fields} disabled={isLoading} idPrefix="login" passwordAutoComplete="current-password" />

          <Button type="submit" variant="primary" disabled={isLoading} className={styles.submitBtn}>
            {isLoading ? 'Bağlantı sınanıyor...' : 'Giriş yap'}
          </Button>
        </form>
      </main>
    </div>
  );
}

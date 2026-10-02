import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import type { AccountCreateRequest, AccountDTO } from '@kaydet/domain';
import { createAccount } from '../../data/api/accounts';
import { ApiClientError } from '../../data/api/errors';
import { useReloadAccounts } from '../../data/MailDataContext';
import { Button } from '../../ui/Button';
import { MailboxFields } from './MailboxFields';
import { useMailboxFields } from './useMailboxFields';
import styles from './AccountSetupForm.module.css';

export interface AccountSetupFormProps {
  onSuccess?: (account: AccountDTO) => void;
  onCancel?: () => void;
  cancelLabel?: string;
  submitLabel?: string;
}

export function AccountSetupForm({
  onSuccess,
  onCancel,
  cancelLabel = 'Vazgeç',
  submitLabel = 'Hesap Ekle',
}: AccountSetupFormProps) {
  const reloadAccounts = useReloadAccounts();
  const navigate = useNavigate();
  const fields = useMailboxFields();

  const [displayName, setDisplayName] = useState('');
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

    const { email, password, imap, smtp } = checked.value;
    // The IMAP/SMTP login name is the e-mail address.
    const payload: AccountCreateRequest = { email, displayName: displayName.trim(), username: email, password, imap, smtp };

    try {
      const created = await createAccount(undefined, payload);
      await reloadAccounts();
      if (onSuccess) {
        onSuccess(created);
      } else {
        navigate(`/a/${created.id}`);
      }
    } catch (err) {
      fields.setShowAdvanced(true);
      if (err instanceof ApiClientError) {
        const hasImapError = err.fields?.some((f) => f.field === 'imap');
        const hasSmtpError = err.fields?.some((f) => f.field === 'smtp');
        if (hasImapError) {
          setErrorMessage(`Gelen sunucu (IMAP): ${err.userMessage}`);
        } else if (hasSmtpError) {
          setErrorMessage(`Giden sunucu (SMTP): ${err.userMessage}`);
        } else {
          setErrorMessage(err.userMessage);
        }
      } else {
        setErrorMessage('Hesap eklenemedi. Lütfen bağlantı ayarlarını kontrol edin.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      {errorMessage && (
        <div className={styles.errorBanner} role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{errorMessage}</span>
        </div>
      )}

      <MailboxFields
        fields={fields}
        disabled={isLoading}
        idPrefix="add-account"
        passwordAutoComplete="new-password"
        afterEmail={
          <div className={styles.field}>
            <label htmlFor="add-account-name" className={styles.label}>
              Ad Soyad (İsteğe bağlı)
            </label>
            <input
              id="add-account-name"
              type="text"
              autoComplete="name"
              disabled={isLoading}
              className={styles.input}
              placeholder="Ad Soyad"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
        }
      />

      <div className={styles.actions}>
        {onCancel && (
          <Button variant="secondary" type="button" onClick={onCancel} disabled={isLoading}>
            {cancelLabel}
          </Button>
        )}
        <Button variant="primary" type="submit" disabled={isLoading}>
          {isLoading ? 'Bağlantı sınanıyor...' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { AccountDTO } from '@kaydet/domain';
import { AccountSetupForm } from './AccountSetupForm';
import styles from './AddAccountModal.module.css';

export interface AddAccountModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: (account: AccountDTO) => void;
}

export function AddAccountModal({ open, onClose, onSuccess }: AddAccountModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      // `showModal` puts the dialog in the top layer with a backdrop; the bare `open`
      // attribute would render it inline and non-modal.
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [open]);

  if (!open) return null;

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="add-account-modal-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
    >
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <h2 id="add-account-modal-title" className={styles.title}>
            Hesap ekle
          </h2>
          <p className={styles.subtitle}>E-postalarınıza erişmek için IMAP/SMTP hesabınızı bağlayın</p>
        </div>
        <button
          type="button"
          className={styles.closeButton}
          onClick={onClose}
          aria-label="Kapat"
        >
          <X size={18} />
        </button>
      </div>

      <AccountSetupForm
        onSuccess={(account) => {
          onClose();
          onSuccess?.(account);
        }}
        onCancel={onClose}
        cancelLabel="Vazgeç"
        submitLabel="Hesap Ekle"
      />
    </dialog>
  );
}

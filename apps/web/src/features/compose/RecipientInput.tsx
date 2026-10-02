import { useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { addressDisplay, isValidEmail, parseAddressList } from '@kaydet/domain';
import type { EmailAddressDTO } from '@kaydet/domain';
import styles from './RecipientInput.module.css';

export interface RecipientInputProps {
  label: string;
  recipients: EmailAddressDTO[];
  onChange: (recipients: EmailAddressDTO[]) => void;
  placeholder?: string;
  maxVisibleChips?: number;
  showCcBccToggle?: boolean;
  onToggleCc?: () => void;
  onToggleBcc?: () => void;
  hasCc?: boolean;
  hasBcc?: boolean;
}

export function RecipientInput({
  label,
  recipients,
  onChange,
  placeholder = '',
  maxVisibleChips = 4,
  showCcBccToggle = false,
  onToggleCc,
  onToggleBcc,
  hasCc = false,
  hasBcc = false,
}: RecipientInputProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputValue, setInputValue] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  const commitCurrentText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const parsed = parseAddressList(trimmed);
    if (parsed.length === 0) return;

    // Filter out duplicates already in the list
    const existing = new Set(recipients.map((r) => r.email.toLowerCase()));
    const toAdd = parsed.filter((p) => !existing.has(p.email.toLowerCase()));

    if (toAdd.length > 0) {
      onChange([...recipients, ...toAdd]);
    }
    setInputValue('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault();
      commitCurrentText(inputValue);
    } else if (e.key === 'Backspace' && inputValue === '' && recipients.length > 0) {
      e.preventDefault();
      // Remove last chip
      const next = recipients.slice(0, -1);
      onChange(next);
    } else if (e.key === 'Tab' && inputValue.trim()) {
      commitCurrentText(inputValue);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (text && (text.includes(',') || text.includes(';') || text.includes('\n') || text.includes(' '))) {
      e.preventDefault();
      commitCurrentText(text);
    }
  };

  const handleRemove = (index: number) => {
    const next = recipients.filter((_, i) => i !== index);
    onChange(next);
    inputRef.current?.focus();
  };

  const visibleRecipients =
    isExpanded || isFocused || recipients.length <= maxVisibleChips
      ? recipients
      : recipients.slice(0, maxVisibleChips);

  const overflowCount = recipients.length - visibleRecipients.length;

  return (
    <div className={styles.row}>
      <div className={styles.labelCol}>
        <label htmlFor={inputId} className={styles.label}>
          {label}
        </label>
      </div>

      <div
        className={styles.chipArea}
        onClick={() => inputRef.current?.focus()}
        role="presentation"
      >
        {visibleRecipients.map((r, idx) => {
          const valid = isValidEmail(r.email);
          const display = addressDisplay(r);

          return (
            <span
              key={`${r.email}-${idx}`}
              className={`${styles.chip} ${!valid ? styles.chipInvalid : ''}`}
              title={!valid ? `Geçersiz e-posta adresi: ${r.email}` : undefined}
            >
              <span className={styles.chipText}>{display}</span>
              <button
                type="button"
                className={styles.chipRemove}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemove(idx);
                }}
                aria-label={`Kaldır: ${display}`}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          );
        })}

        {overflowCount > 0 && (
          <button
            type="button"
            className={styles.overflowBtn}
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(true);
              inputRef.current?.focus();
            }}
            aria-label={`${overflowCount} alıcıyı daha göster`}
          >
            +{overflowCount}
          </button>
        )}

        <input
          ref={inputRef}
          id={inputId}
          type="text"
          className={styles.input}
          value={inputValue}
          placeholder={recipients.length === 0 ? placeholder : ''}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocus={() => {
            setIsFocused(true);
            setIsExpanded(true);
          }}
          onBlur={() => {
            setIsFocused(false);
            commitCurrentText(inputValue);
          }}
          aria-label={label}
        />
      </div>

      {showCcBccToggle && (
        <div className={styles.toggles}>
          <button
            type="button"
            className={`${styles.toggleBtn} ${hasCc ? styles.toggleBtnActive : ''}`}
            onClick={onToggleCc}
            aria-pressed={hasCc}
          >
            Cc
          </button>
          <button
            type="button"
            className={`${styles.toggleBtn} ${hasBcc ? styles.toggleBtnActive : ''}`}
            onClick={onToggleBcc}
            aria-pressed={hasBcc}
          >
            Bcc
          </button>
        </div>
      )}
    </div>
  );
}

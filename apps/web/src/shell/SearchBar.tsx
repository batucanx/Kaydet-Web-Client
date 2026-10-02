import { Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { IconButton } from '../ui/IconButton';
import styles from './SearchBar.module.css';

interface SearchBarProps {
  /** Called with the trimmed query on Enter. */
  onSubmit: (query: string) => void;
  /** Controlled or initial query text. */
  initialValue?: string;
  /** Live change callback. */
  onChange?: (value: string) => void;
  /** Called when the clear button is pressed. */
  onClear?: () => void;
  /** Focus on mount — only used when the user just opened the mobile search row. */
  focusOnMount?: boolean;
  onClose?: () => void;
  showShortcutHint?: boolean;
}

const isEditable = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** Prominent, not oversized search field. `/` focuses it (web convention); Esc clears/blur. */
export function SearchBar({
  onSubmit,
  initialValue = '',
  onChange,
  onClear,
  focusOnMount,
  onClose,
  showShortcutHint = true,
}: SearchBarProps) {
  const [value, setValue] = useState(initialValue);
  const [prevInitial, setPrevInitial] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  if (initialValue !== prevInitial) {
    setPrevInitial(initialValue);
    setValue(initialValue);
  }

  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus();
  }, [focusOnMount]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditable(event.target)) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleChange = (newValue: string) => {
    setValue(newValue);
    onChange?.(newValue);
  };

  const handleClear = () => {
    setValue('');
    onChange?.('');
    onClear?.();
    inputRef.current?.focus();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const query = value.trim();
    if (query) onSubmit(query);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    if (value) handleClear();
    else {
      inputRef.current?.blur();
      onClose?.();
    }
  };

  return (
    <form className={styles.form} role="search" onSubmit={submit}>
      <Search size={16} className={styles.icon} aria-hidden="true" />
      <input
        ref={inputRef}
        className={styles.input}
        type="search"
        name="q"
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ara"
        aria-label="Ara"
        autoComplete="off"
        enterKeyHint="search"
      />
      {value ? (
        <IconButton
          icon={X}
          label="Aramayı temizle"
          size="sm"
          className={styles.clear}
          onClick={handleClear}
        />
      ) : (
        showShortcutHint && (
          <kbd className={styles.kbd} aria-hidden="true">
            /
          </kbd>
        )
      )}
    </form>
  );
}

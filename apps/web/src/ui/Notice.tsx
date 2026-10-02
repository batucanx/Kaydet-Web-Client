import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import styles from './Notice.module.css';

export interface NoticeOptions {
  message: string;
  /** Text button next to the message (mobile: "Geri al"). */
  actionLabel?: string;
  onAction?: () => void;
  /** ms. mobile: 3 s default; undo notices 5 s (`_undoNoticeDuration`). */
  duration?: number;
}

interface NoticeContextValue {
  show: (options: NoticeOptions) => void;
  dismiss: () => void;
}

const NoticeContext = createContext<NoticeContextValue | null>(null);

interface Active extends NoticeOptions {
  id: number;
}

const isEditable = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/**
 * Transient message (mobile `KaydetNotice`). One at a time; a new notice replaces the old one.
 * Accessibility: rendered in an always-mounted polite live region; the timer pauses while the
 * pointer or keyboard focus is inside; Esc dismisses; Ctrl/Cmd+Z triggers an "undo" action.
 */
export function NoticeProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<Active | null>(null);
  const [paused, setPaused] = useState(false);
  const counter = useRef(0);

  const dismiss = useCallback(() => setActive(null), []);
  const show = useCallback((options: NoticeOptions) => {
    counter.current += 1;
    setPaused(false);
    setActive({ ...options, id: counter.current });
  }, []);

  useEffect(() => {
    if (!active || paused) return;
    const timer = window.setTimeout(() => setActive(null), active.duration ?? 3000);
    return () => window.clearTimeout(timer);
  }, [active, paused]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActive(null);
      } else if (
        active.onAction &&
        active.actionLabel &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'z' &&
        !isEditable(event.target)
      ) {
        event.preventDefault();
        active.onAction();
        setActive(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active]);

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <NoticeContext.Provider value={value}>
      {children}
      <div className={styles.region} role="status" aria-live="polite" aria-atomic="true">
        {active && (
          <div
            key={active.id}
            className={styles.notice}
            onPointerEnter={() => setPaused(true)}
            onPointerLeave={() => setPaused(false)}
            onFocusCapture={() => setPaused(true)}
            onBlurCapture={() => setPaused(false)}
          >
            <span className={styles.message}>{active.message}</span>
            {active.actionLabel && (
              <button
                type="button"
                className={styles.action}
                onClick={() => {
                  active.onAction?.();
                  setActive(null);
                }}
              >
                {active.actionLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </NoticeContext.Provider>
  );
}

export function useNotice(): NoticeContextValue {
  const ctx = useContext(NoticeContext);
  if (!ctx) throw new Error('useNotice must be used inside <NoticeProvider>');
  return ctx;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ThemeName } from '@kaydet/tokens';

/** mobile: AppThemeMode (system / light / dark), default dark. Labels are the mobile strings. */
export type ThemeMode = 'system' | 'light' | 'dark';
export const themeModeLabels: Record<ThemeMode, string> = {
  system: 'Sistem ayarını izle',
  light: 'Açık',
  dark: 'Koyu',
};
export const themeModes: readonly ThemeMode[] = ['system', 'light', 'dark'];

const STORAGE_KEY = 'kaydet.themeMode';
const DEFAULT_MODE: ThemeMode = 'dark';

function readStoredMode(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'system' || value === 'light' || value === 'dark') return value;
  } catch {
    /* storage unavailable (private mode) — fall back to the default */
  }
  return DEFAULT_MODE;
}

const prefersDark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches;

interface ThemeContextValue {
  mode: ThemeMode;
  theme: ThemeName;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [systemDark, setSystemDark] = useState<boolean>(prefersDark);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const theme: ThemeName = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* non-fatal */
    }
  }, []);

  const value = useMemo(() => ({ mode, theme, setMode }), [mode, theme, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

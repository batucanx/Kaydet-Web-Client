import { createContext, useContext } from 'react';
import type { ShellMode } from '@kaydet/tokens';

export interface ShellContextValue {
  mode: ShellMode;
  /** Mobile-web navigation drawer. Always false outside the mobile layout. */
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
}

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error('useShell must be used inside <AppShell>');
  return ctx;
}

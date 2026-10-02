import { useSyncExternalStore } from 'react';
import { breakpoints } from '@kaydet/tokens';
import type { ShellMode } from '@kaydet/tokens';

/**
 * Layout mode from the token breakpoints (single source of truth — CSS keys off
 * `data-shell="<mode>"` and never repeats a breakpoint literal).
 *
 *   mobile  < 768   drawer navigation, stacked rows, touch targets
 *   tablet  ≥ 768   icon-only sidebar rail
 *   laptop  ≥ 1024  full sidebar (240)
 *   desktop ≥ 1280  full sidebar (256)
 *   wide    ≥ 1600  full sidebar (272)
 */
export function modeForWidth(width: number): ShellMode {
  if (width >= breakpoints.wide) return 'wide';
  if (width >= breakpoints.desktop) return 'desktop';
  if (width >= breakpoints.laptop) return 'laptop';
  if (width >= breakpoints.tablet) return 'tablet';
  return 'mobile';
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

export function useShellMode(): ShellMode {
  return useSyncExternalStore(
    subscribe,
    () => modeForWidth(window.innerWidth),
    () => 'laptop',
  );
}

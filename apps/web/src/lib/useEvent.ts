import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Stable function identity that always calls the latest closure. Lets memoized rows receive
 * callbacks that never change (so they never re-render because of them).
 */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

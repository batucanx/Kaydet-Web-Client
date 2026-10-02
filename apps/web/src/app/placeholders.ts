import { useCallback } from 'react';
import { useNotice } from '../ui/Notice';

/**
 * Single, greppable place for actions whose backend/feature does not exist yet in this phase
 * (compose, search, add account). Each call site names the feature; the notice is honest.
 * Delete the call sites as the real features land.
 */
export function useNotImplemented(): (feature: string) => void {
  const { show } = useNotice();
  return useCallback((feature: string) => show({ message: `${feature} sonraki aşamada bağlanacak.` }), [show]);
}

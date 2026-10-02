import type { UseCases } from '../../application/index.ts';
import type { RouteRegistrar } from '../route-registry.ts';

/** `GET /events` (SSE) is registered so the contract is complete, but the stream itself is a later phase. */
export function registerEventRoutes(r: RouteRegistrar, u: UseCases): void {
  r.bind('streamEvents', ({ ctx }) => u.streamEvents(ctx));
}

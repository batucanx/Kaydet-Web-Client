import type { UseCases } from '../../application/index.ts';
import type { RouteRegistrar } from '../route-registry.ts';

export function registerSearchRoutes(r: RouteRegistrar, u: UseCases): void {
  r.bind('search', ({ ctx, query }) => u.search(ctx, query));
}

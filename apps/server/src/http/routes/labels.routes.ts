import type { UseCases } from '../../application/index.ts';
import type { RouteRegistrar } from '../route-registry.ts';

export function registerLabelRoutes(r: RouteRegistrar, u: UseCases): void {
  r.bind('listLabels', ({ ctx, params }) => u.listLabels(ctx, params.accountId));
  r.bind('createLabel', ({ ctx, params, body }) => u.createLabel(ctx, params.accountId, body));
  r.bind('deleteLabel', ({ ctx, params }) => u.deleteLabel(ctx, params.accountId, params.labelId));
}

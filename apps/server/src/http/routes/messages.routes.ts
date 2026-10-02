import type { UseCases } from '../../application/index.ts';
import type { RouteRegistrar } from '../route-registry.ts';

export function registerMessageRoutes(r: RouteRegistrar, u: UseCases): void {
  r.bind('listMessages', ({ ctx, params, query }) => u.listMessages(ctx, params.accountId, query));
  r.bind('getMessage', ({ ctx, params }) => u.getMessage(ctx, params.messageId));
  r.bind('applyMessageActions', ({ ctx, body }) => u.applyMessageActions(ctx, body));
  r.bind('undoAction', ({ ctx, params }) => u.undoAction(ctx, params.token));
}

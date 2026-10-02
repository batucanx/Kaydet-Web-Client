import type { UseCases } from '../../application/index.ts';
import type { RouteRegistrar } from '../route-registry.ts';

export function registerAccountRoutes(r: RouteRegistrar, u: UseCases): void {
  r.bind('listAccounts', ({ ctx }) => u.listAccounts(ctx));
  r.bind('createAccount', ({ ctx, body }) => u.createAccount(ctx, body));
  r.bind('updateAccount', ({ ctx, params, body }) => u.updateAccount(ctx, params.accountId, body));
  r.bind('deleteAccount', ({ ctx, params }) => u.deleteAccount(ctx, params.accountId));
  r.bind('syncAccount', ({ ctx, params }) => u.syncAccount(ctx, params.accountId));
}

/**
 * Authorization boundary of the application: request context → user → account.
 *
 *   session ──▶ user ──▶ owned account ──▶ AuthorizedAccount ──▶ repositories / mail ports
 *
 * An `accountId` from a URL, query or body is only a CLAIM. `authorize` accepts it only when the account belongs
 * to the acting user, and answers `account_not_found` otherwise — for a foreign account exactly as for a
 * nonexistent one, so account existence is never revealed (`forbidden` would leak it).
 */
import { AppError } from '../errors.ts';
import { grantAccountAccess } from '../context/authorized-account.ts';
import type { AuthorizedAccount } from '../context/authorized-account.ts';
import type { RequestContext } from '../context/request-context.ts';
import type { AccountRepository } from '../ports/repositories/account-repository.ts';

export interface AccountAccess {
  /** The acting user's id, or `not_authenticated` / `session_expired`. */
  requireUserId(ctx: RequestContext): string;
  authorize(ctx: RequestContext, accountId: string): Promise<AuthorizedAccount>;
  /** Every account of the acting user (cross-account search). */
  authorizeAll(ctx: RequestContext): Promise<AuthorizedAccount[]>;
}

export function requireUserId(ctx: RequestContext): string {
  if (ctx.actor.kind === 'user') return ctx.actor.userId;
  throw new AppError(ctx.session.status === 'expired' ? 'session_expired' : 'not_authenticated');
}

export function createAccountAccess(accounts: AccountRepository): AccountAccess {
  return {
    requireUserId,
    async authorize(ctx, accountId) {
      const userId = requireUserId(ctx);
      const account = await accounts.findOwned(userId, accountId);
      if (account === null) throw new AppError('account_not_found');
      return grantAccountAccess({ id: account.id, userId, email: account.email });
    },
    async authorizeAll(ctx) {
      const userId = requireUserId(ctx);
      const owned = await accounts.listByUser(userId);
      return owned.map((a) => grantAccountAccess({ id: a.id, userId, email: a.email }));
    },
  };
}

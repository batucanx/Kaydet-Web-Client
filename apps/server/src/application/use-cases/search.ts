import type { SearchPageDTO, SearchParams } from '@kaydet/domain';
import { defineUseCase } from '../errors.ts';
import type { RequestContext } from '../context/request-context.ts';
import { toCursorPage, toPageRequest } from '../pagination.ts';
import type { UseCaseDeps } from './deps.ts';

export function createSearchUseCases({ access, messages }: Pick<UseCaseDeps, 'access' | 'messages'>) {
  return {
    search: defineUseCase('search.run', async (ctx: RequestContext, params: SearchParams): Promise<SearchPageDTO> => {
      // "All accounts" means all of the USER's accounts; a named account must be one of them.
      const accounts = params.accounts.kind === 'all' ? await access.authorizeAll(ctx) : [await access.authorize(ctx, params.accounts.accountId)];
      const binding = JSON.stringify(['search', accounts.map((a) => a.id), params.q, params.filters, params.dateRange]);
      const page = await messages.search(accounts, {
        q: params.q,
        filters: params.filters,
        dateRange: params.dateRange,
        page: toPageRequest(binding, params.cursor, params.limit),
      });
      return toCursorPage(binding, page);
    }),
  };
}

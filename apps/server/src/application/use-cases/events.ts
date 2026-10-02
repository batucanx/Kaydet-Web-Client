import { AppError, defineUseCase } from '../errors.ts';
import type { RequestContext } from '../context/request-context.ts';
import type { UseCaseDeps } from './deps.ts';

export function createEventUseCases({ access }: Pick<UseCaseDeps, 'access'>) {
  return {
    /**
     * Deferred: the SSE stream (`GET /events`) is a later phase. The bus it will subscribe to already exists and
     * use cases already publish to it; only the transport is missing.
     */
    streamEvents: defineUseCase('events.stream', async (ctx: RequestContext): Promise<never> => {
      access.requireUserId(ctx);
      throw new AppError('service_unavailable');
    }),
  };
}

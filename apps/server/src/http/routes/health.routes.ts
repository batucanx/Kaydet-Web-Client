import { createApiError } from '@kaydet/domain';
import type { FastifyInstance } from 'fastify';

export interface Lifecycle {
  isClosing(): boolean;
}

/** Operational endpoints (not part of the API contract; never prefixed, never authenticated). */
export function registerHealthRoutes(app: FastifyInstance, lifecycle: Lifecycle): void {
  /** Liveness: the process answers. */
  app.get('/health', () => ({ status: 'ok' }));

  /**
   * Readiness: can it take traffic? Phase 3 has no required infrastructure (no database, no mail servers), so this
   * only turns 503 while shutting down. Infrastructure checks join here when it exists.
   */
  app.get('/ready', (request, reply) => {
    if (lifecycle.isClosing()) return reply.code(503).send({ error: createApiError('service_unavailable', { requestId: request.id }) });
    return { status: 'ready' };
  });
}

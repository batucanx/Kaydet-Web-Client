/**
 * Request identity and context.
 *
 *  - Request id: a safe inbound `X-Request-Id` (set by a trusted proxy/load balancer) is kept for correlation,
 *    anything else is replaced by a UUID. The id is echoed in the `X-Request-Id` header and in every error body.
 *  - `request.ctx`: the explicit `RequestContext` (requestId, actor, session, metadata), built in `onRequest`
 *    from the session cookie via the application's session resolution.
 *  - One structured access-log line per request: requestId, method, route pattern, status, duration. The route
 *    PATTERN is logged, never the raw URL, so ids and search terms in paths/queries stay out of logs.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RequestContext, ResolvedSession } from '../../application/index.ts';
import { buildRequestContext } from '../middleware/auth-context.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the `onRequest` hook of `registerRequestContext`; present in every handler. */
    ctx: RequestContext;
  }
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function generateRequestId(request: { headers: Record<string, string | string[] | undefined> }): string {
  const inbound = request.headers['x-request-id'];
  return typeof inbound === 'string' && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
}

export function registerRequestContext(
  app: FastifyInstance,
  options: { resolveSession: (token: string | null) => Promise<ResolvedSession>; cookieName: string },
): void {
  app.decorateRequest('ctx', undefined as unknown as RequestContext);

  app.addHook('onRequest', async (request: FastifyRequest) => {
    request.ctx = await buildRequestContext(request, options.resolveSession, options.cookieName);
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header('x-request-id', request.id);
    done(null, payload);
  });

  app.addHook('onResponse', (request, reply, done) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? '(unmatched)',
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime * 10) / 10,
      },
      'request completed',
    );
    done();
  });
}

/**
 * CSRF defence for a cookie-authenticated API. CORS is NOT a CSRF defence (it restricts who may READ a response; a
 * cross-site form or `fetch` with `no-cors` can still SEND a request that carries the cookie), so two independent
 * checks guard every state-changing request:
 *
 *  1. ORIGIN check (all POST/PUT/PATCH/DELETE, including sign-in): if the browser sent an `Origin` header it must be one
 *     of the configured origins, else 403. Browsers always attach `Origin` to cross-origin state-changing requests, so a
 *     malicious page is rejected here. (A missing `Origin` = non-browser client or same-origin navigation quirk: the
 *     token check below still applies.) `SameSite=Lax` on the cookie is a third layer: it is not sent on cross-site POSTs.
 *
 *  2. TOKEN check (state-changing requests of session routes): header `X-CSRF-Token` must equal the token derived from
 *     the session secret. The client learns the token from the `X-CSRF-Token` response header of `POST /session` and
 *     `GET /session` (readable cross-origin only by allowed origins) and keeps it in memory. It is a different value
 *     from the session secret, so exposing it to JavaScript does not expose the session. Sign-in has no session yet, so
 *     it is protected by the Origin check only (login CSRF is a limited risk; see SECURITY.md).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../application/index.ts';
import { CSRF_HEADER } from '../../config/index.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const isStateChanging = (method: string): boolean => !SAFE_METHODS.has(method.toUpperCase());

/** Global `onRequest` hook: rejects state-changing requests from origins that are not configured. */
export function originGuard(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  return (request: FastifyRequest, _reply: FastifyReply, done: (error?: Error) => void): void => {
    const origin = request.headers.origin;
    if (isStateChanging(request.method) && origin !== undefined && !allowed.has(origin)) {
      done(new AppError('forbidden', { fields: [{ field: 'origin', reason: 'not_allowed' }] }));
      return;
    }
    done();
  };
}

/** Route-level `onRequest` hook (after `requireSession`): the token must match for state-changing methods. */
export function csrfGuard(verify: (request: FastifyRequest, presented: string | null) => boolean) {
  return (request: FastifyRequest, _reply: FastifyReply, done: (error?: Error) => void): void => {
    if (!isStateChanging(request.method)) return done();
    const header = request.headers[CSRF_HEADER];
    const presented = typeof header === 'string' ? header : null;
    if (verify(request, presented)) return done();
    return done(new AppError('forbidden', { fields: [{ field: CSRF_HEADER, reason: presented === null ? 'missing' : 'invalid' }] }));
  };
}

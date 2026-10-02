/**
 * Turns the session cookie into the application's `RequestContext` and guards session-only routes.
 *
 * HTTP knows nothing about how sessions are stored or validated: it hands the cookie value to the application
 * (`resolveSession`) and receives who the caller is. The cookie value is an opaque credential — never logged or echoed.
 *
 * Per-route guards (registered as `onRequest` hooks, so they run BEFORE the body is read):
 *   requireSession  → 401 not_authenticated / session_expired
 *   requireCsrf     → 403 forbidden, for state-changing methods of session routes (see `csrf.ts`)
 */
import type { FastifyRequest } from 'fastify';
import { ANONYMOUS_ACTOR, NO_SESSION, requireUserId } from '../../application/index.ts';
import type { Actor, RequestContext, ResolvedSession, SessionState } from '../../application/index.ts';
import type { SameSiteMode } from '../../config/index.ts';

const MAX_TOKEN_LENGTH = 512;

/** Value of cookie `name` in a `Cookie` header, or `null`. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    const raw = part.slice(at + 1).trim().replace(/^"(.*)"$/, '$1');
    if (raw === '' || raw.length > MAX_TOKEN_LENGTH) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}

export interface SessionCookieOptions {
  readonly name: string;
  readonly secure: boolean;
  readonly sameSite: SameSiteMode;
  /** Cookie path: the API prefix, so the credential is not sent to anything else on the host. */
  readonly path: string;
}

/**
 * `Set-Cookie` for the session: `HttpOnly` (invisible to JavaScript), `SameSite` as configured (Lax or Strict — never
 * None), `Secure` in production, an explicit `Path`, no `Domain` (host-only), and a bounded `Max-Age`/`Expires`.
 * `expiresAt: null` writes the clearing cookie.
 */
export function serializeSessionCookie(options: SessionCookieOptions, token: string, expiresAt: Date | null, now: Date): string {
  const parts = [`${options.name}=${encodeURIComponent(token)}`, `Path=${options.path === '' ? '/' : options.path}`, 'HttpOnly', `SameSite=${options.sameSite === 'strict' ? 'Strict' : 'Lax'}`];
  if (options.secure) parts.push('Secure');
  if (expiresAt === null) {
    parts.push('Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  } else {
    parts.push(`Max-Age=${Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000))}`, `Expires=${expiresAt.toUTCString()}`);
  }
  return parts.join('; ');
}

export async function buildRequestContext(
  request: FastifyRequest,
  resolveSession: (token: string | null) => Promise<ResolvedSession>,
  cookieName: string,
): Promise<RequestContext> {
  const resolved = await resolveSession(readCookie(request.headers.cookie, cookieName));
  let actor: Actor = ANONYMOUS_ACTOR;
  let session: SessionState = NO_SESSION;
  if (resolved.status === 'active') {
    actor = { kind: 'user', userId: resolved.userId };
    session = { status: 'active', id: resolved.sessionId, expiresAt: resolved.expiresAt, csrfToken: resolved.csrfToken };
  } else if (resolved.status === 'expired') {
    session = { status: 'expired' };
  }
  return {
    requestId: request.id,
    actor,
    session,
    metadata: { method: request.method, route: request.routeOptions.url ?? '(unmatched)', clientAddress: request.ip },
  };
}

/** Route-level `onRequest` hook for `auth: 'session'` routes: anonymous routes are only those the contract marks `none`. */
export function requireSession(request: FastifyRequest, _reply: unknown, done: (error?: Error) => void): void {
  try {
    requireUserId(request.ctx);
    done();
  } catch (error) {
    done(error instanceof Error ? error : new Error('unauthenticated'));
  }
}

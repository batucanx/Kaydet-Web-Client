/**
 * Binds application handlers to the contract's route table (`api` in `@kaydet/domain`).
 *
 * The contract is the only description of a route: method, path, auth requirement, params/query/body schemas,
 * response schema and success status all come from `api[name]`. `bind` does, for every route and in this order:
 *
 *   1. session guard (`onRequest`, before the body is read)          → not_authenticated / session_expired
 *   2. validate params, query, body with the contract's Zod schemas   → invalid_request (+ field list)
 *   3. call the handler (a use case; no error handling in routes)
 *   4. validate the result against the response schema (dev/test)     → internal_error on contract drift
 *   5. send it with the contract's success status
 *
 * Errors thrown anywhere in 1–4 reach the central error handler; nothing here formats an error.
 */
import { api } from '@kaydet/domain';
import type { ApiRouteName, RouteSpec } from '@kaydet/domain';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import { AppError } from '../application/index.ts';
import type { AttachmentDownload, Clock, RequestContext, UseCases } from '../application/index.ts';
import { CSRF_HEADER } from '../config/index.ts';
import type { ServerConfig } from '../config/index.ts';
import { requireSession, serializeSessionCookie } from './middleware/auth-context.ts';
import { csrfGuard } from './middleware/csrf.ts';
import { parseWithContract } from './plugins/validation.ts';
import { sendAttachment } from './serializers/attachment.ts';

type Spec<N extends ApiRouteName> = (typeof api)[N];
type Out<S> = S extends z.ZodType ? z.output<S> : undefined;

export type ParamsOf<N extends ApiRouteName> = Spec<N> extends { params: infer P } ? Out<P> : undefined;
export type QueryOf<N extends ApiRouteName> = Spec<N> extends { query: infer Q } ? Out<Q> : undefined;
export type BodyOf<N extends ApiRouteName> = Spec<N> extends { body: infer B } ? Out<B> : undefined;
export type ResultOf<N extends ApiRouteName> =
  Spec<N>['response'] extends z.ZodType
    ? z.output<Spec<N>['response']>
    : Spec<N>['response'] extends { kind: 'binary' }
      ? AttachmentDownload
      : Spec<N>['response'] extends { kind: 'empty' }
        ? void
        : never;

/** How a handler starts/ends the browser's session (only the session routes do). */
export interface SessionTransport {
  /** Sets the session cookie and exposes the CSRF token in the `X-CSRF-Token` response header. */
  start(token: string, expiresAt: Date, csrfToken: string): void;
  /** Clears the session cookie. */
  end(): void;
  /** Exposes the CSRF token of the current session (or nothing) in the response header. */
  exposeCsrf(csrfToken: string | null): void;
}

/** Structured logger for audit lines. Pass ids and codes only — never credentials, tokens or identifiers. */
export interface RouteLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

export interface HandlerInput<N extends ApiRouteName> {
  readonly ctx: RequestContext;
  readonly params: ParamsOf<N>;
  readonly query: QueryOf<N>;
  readonly body: BodyOf<N>;
  readonly session: SessionTransport;
  readonly log: RouteLogger;
}
export type RouteHandler<N extends ApiRouteName> = (input: HandlerInput<N>) => Promise<ResultOf<N>>;

export interface RouteRegistrar {
  bind<N extends ApiRouteName>(name: N, handler: RouteHandler<N>): void;
}

type LooseHandler = (input: HandlerInput<ApiRouteName>) => Promise<unknown>;

const isZod = (value: unknown): value is z.ZodType =>
  typeof value === 'object' && value !== null && typeof (value as { safeParse?: unknown }).safeParse === 'function';

export function createRouteRegistrar(
  app: FastifyInstance,
  config: Pick<ServerConfig, 'apiPrefix' | 'limits' | 'cookie' | 'validateResponses'>,
  deps: { readonly useCases: Pick<UseCases, 'verifyCsrf'>; readonly clock: Clock },
) {
  const bound = new Set<ApiRouteName>();
  const cookieOptions = { name: config.cookie.name, secure: config.cookie.secure, sameSite: config.cookie.sameSite, path: config.apiPrefix };
  const csrf = csrfGuard((request, presented) => deps.useCases.verifyCsrf(request.ctx, presented));

  const registrar: RouteRegistrar = {
    bind(name, handler) {
      const spec: RouteSpec = api[name];
      if (bound.has(name)) throw new Error(`route "${name}" is bound twice`);
      bound.add(name);
      const run = handler as unknown as LooseHandler;

      app.route({
        method: spec.method,
        url: spec.path,
        // Only the draft upsert carries large bodies (subject/text/html maxima of the contract).
        bodyLimit: name === 'putDraft' ? config.limits.draftBodyBytes : config.limits.jsonBodyBytes,
        // Session routes: session first (401), then CSRF for state-changing methods (403) — both before the body is read.
        onRequest: spec.auth === 'session' ? [requireSession, csrf] : [],
        handler: async (request, reply) => {
          // A multipart upload is never buffered or read here; close the connection instead of draining it.
          if (spec.body !== undefined && !isZod(spec.body)) void reply.header('connection', 'close');

          const params = spec.params === undefined ? undefined : parseWithContract(spec.params, request.params, 'params');
          const query = spec.query === undefined ? undefined : parseWithContract(spec.query, request.query, 'query');
          const body = spec.body === undefined || !isZod(spec.body) ? undefined : parseWithContract(spec.body, request.body, 'body');

          const result = await run({
            ctx: request.ctx,
            params: params as never,
            query: query as never,
            body: body as never,
            session: {
              start: (token, expiresAt, csrfToken) => {
                void reply.header('set-cookie', serializeSessionCookie(cookieOptions, token, expiresAt, deps.clock.now()));
                void reply.header(CSRF_HEADER, csrfToken);
              },
              end: () => void reply.header('set-cookie', serializeSessionCookie(cookieOptions, '', null, deps.clock.now())),
              exposeCsrf: (csrfToken) => {
                if (csrfToken !== null) void reply.header(CSRF_HEADER, csrfToken);
              },
            },
            log: request.log,
          });
          return send(reply, spec, result, query, config.validateResponses, name);
        },
      });
    },
  };

  return {
    registrar,
    /** Every route of the contract must have a handler: a missing one is a startup error, not a runtime 404. */
    assertComplete(): void {
      const missing = (Object.keys(api) as ApiRouteName[]).filter((name) => !bound.has(name));
      if (missing.length > 0) throw new Error(`Contract routes without a handler: ${missing.join(', ')}`);
    },
  };
}

function send(reply: FastifyReply, spec: RouteSpec, result: unknown, query: unknown, validate: boolean, name: string): FastifyReply {
  const response = spec.response;
  if (isZod(response)) {
    if (validate) {
      const check = response.safeParse(result);
      if (!check.success) {
        // Contract drift: the backend produced something the contract does not allow. Never send it.
        const issues = check.error.issues.map((i) => `${i.path.join('.') || '(root)'}:${i.code}`);
        throw new AppError('internal_error', { operation: `${name}.response-contract`, cause: new Error(`response violates contract: ${issues.join(', ')}`) });
      }
    }
    return reply.code(spec.status).send(result);
  }
  if ('kind' in response && response.kind === 'binary') {
    const download = (query as { download?: boolean } | undefined)?.download === true;
    return sendAttachment(reply, result as AttachmentDownload, download);
  }
  if ('kind' in response && response.kind === 'empty') return reply.code(spec.status).send();
  // SSE: no adapter yet; the use case rejects before a result exists.
  throw new AppError('service_unavailable', { operation: `${name}.stream` });
}

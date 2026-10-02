/**
 * The single place where errors become HTTP responses.
 *
 *   thrown anywhere ──▶ mapError ──▶ { status, ApiError } ──▶ `{ error: ApiError }` (contract) + one log line
 *
 * Routes and use cases never format errors. What the browser receives is only the contract `ApiError`: a code,
 * its user-safe Turkish message, the requestId and structured extras. Stack traces, causes, provider text, SQL
 * and credentials stay in the server log.
 */
import { ApiErrorResponseSchema, createApiError, httpStatusOf } from '@kaydet/domain';
import type { ApiError } from '@kaydet/domain';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isAppError } from '../../application/index.ts';
import type { ServerConfig } from '../../config/index.ts';

export interface MappedError {
  readonly status: number;
  readonly error: ApiError;
  /** Set for unexpected failures: logged with a stack, never sent. */
  readonly internal: unknown;
  /** Server-side context for the log line. */
  readonly operation: string | undefined;
  readonly cause: unknown;
}

/** Fastify/Node transport errors (bad JSON, body too large, unsupported media type, timeouts) carry a `statusCode`. */
function isTransportError(error: unknown): error is FastifyError & { statusCode: number } {
  return typeof error === 'object' && error !== null && typeof (error as { statusCode?: unknown }).statusCode === 'number';
}

export function mapError(error: unknown, requestId: string): MappedError {
  if (isAppError(error)) {
    const { operation, cause, ...extras } = error.options;
    const status = httpStatusOf(error.code);
    return {
      // Contract status 0 = raised client-side; on the wire the nearest truthful answer is 503.
      status: status === 0 ? 503 : status,
      error: createApiError(error.code, { ...extras, requestId }),
      internal: undefined,
      operation,
      cause: cause ?? error.cause,
    };
  }

  if (isTransportError(error) && error.statusCode >= 400 && error.statusCode < 500) {
    // Malformed JSON, oversize body, wrong media type, … There is no dedicated contract code: all are `invalid_request`,
    // keeping the transport's own status (413/415/…) because that is what HTTP clients act on.
    if (error.statusCode === 408) return { status: 504, error: createApiError('request_timeout', { requestId }), internal: undefined, operation: undefined, cause: undefined };
    return { status: error.statusCode, error: createApiError('invalid_request', { requestId }), internal: undefined, operation: undefined, cause: undefined };
  }

  return { status: 500, error: createApiError('internal_error', { requestId }), internal: error, operation: undefined, cause: undefined };
}

export function registerErrorHandling(app: FastifyInstance, config: Pick<ServerConfig, 'validateResponses'>): void {
  const respond = (request: FastifyRequest, reply: FastifyReply, mapped: MappedError) => {
    let body: unknown = { error: mapped.error };
    if (config.validateResponses) {
      const check = ApiErrorResponseSchema.safeParse(body);
      if (!check.success) {
        request.log.error({ issues: check.error.issues.map((i) => i.path.join('.')) }, 'error response violates the contract');
        body = { error: createApiError('internal_error', { requestId: request.id }) };
      }
    }
    const retryAfter = mapped.error.retryAfterSeconds;
    if (retryAfter !== undefined) void reply.header('retry-after', String(retryAfter));
    return reply.code(mapped.status).send(body);
  };

  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error, request.id);
    const fields = {
      code: mapped.error.code,
      kind: mapped.error.kind,
      status: mapped.status,
      operation: mapped.operation ?? request.ctx?.metadata.route,
    };
    if (mapped.internal !== undefined) {
      request.log.error({ ...fields, err: mapped.internal }, 'unexpected error');
    } else if (mapped.status >= 500) {
      request.log.error({ ...fields, err: mapped.cause }, 'request failed');
    } else {
      request.log.info(fields, 'request rejected');
    }
    return respond(request, reply, mapped);
  });

  // Unknown routes and methods: the contract has no `route_not_found` code, so this is `invalid_request` with HTTP 404.
  app.setNotFoundHandler((request, reply) => {
    request.log.info({ code: 'invalid_request', status: 404, operation: 'route.not_found' }, 'request rejected');
    return respond(request, reply, {
      status: 404,
      error: createApiError('invalid_request', { requestId: request.id }),
      internal: undefined,
      operation: undefined,
      cause: undefined,
    });
  });
}

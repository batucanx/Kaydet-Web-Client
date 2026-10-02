/**
 * Transport-level security baseline: explicit CORS and hardening headers.
 *
 *  - CORS: only the origins listed in the configuration (never `*`, credentials allowed for the session cookie).
 *    No `Origin` header (same-origin, curl, health probes) is unaffected. An origin that is not listed simply
 *    gets no CORS headers, so the browser blocks the response.
 *  - Headers: this is an API — JSON and file downloads, never a document to render — so the CSP is `default-src
 *    'none'`, nothing is cached (private mail data), and sniffing/framing are off. HSTS only in production.
 *
 * CSRF is a separate mechanism (`middleware/csrf.ts`): CORS decides who may READ responses, not who may SEND requests.
 */
import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../../config/index.ts';

export async function registerCors(app: FastifyInstance, config: Pick<ServerConfig, 'cors'>): Promise<void> {
  const allowed = new Set(config.cors.allowedOrigins);
  await app.register(cors, {
    origin: (origin, callback) => callback(null, origin === undefined ? true : allowed.has(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-Request-Id', 'X-CSRF-Token'],
    exposedHeaders: ['X-Request-Id', 'X-CSRF-Token', 'Content-Disposition', 'Retry-After'],
    maxAge: 600,
  });
}

export function registerSecurityHeaders(app: FastifyInstance, config: Pick<ServerConfig, 'nodeEnv'>): void {
  const production = config.nodeEnv === 'production';
  app.addHook('onSend', (_request, reply, payload, done) => {
    const defaults: Record<string, string> = {
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-site',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'cache-control': 'no-store',
    };
    if (production) defaults['strict-transport-security'] = 'max-age=15552000; includeSubDomains';
    for (const [name, value] of Object.entries(defaults)) {
      if (!reply.hasHeader(name)) void reply.header(name, value);
    }
    done(null, payload);
  });
}

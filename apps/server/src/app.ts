/**
 * The HTTP application: Fastify instance + plugins + contract routes, built from injected dependencies.
 *
 * This module knows the application layer (use cases, ports as types) and Fastify. It never imports an
 * infrastructure adapter — which adapters back the ports is decided in `compose.ts` and handed in here, so a test
 * can build the same app over fakes.
 */
import Fastify, { LogController } from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Clock, UseCases } from './application/index.ts';
import type { ServerConfig } from './config/index.ts';
import { registerHealthRoutes } from './http/routes/health.routes.ts';
import { registerAccountRoutes } from './http/routes/accounts.routes.ts';
import { registerAttachmentRoutes } from './http/routes/attachments.routes.ts';
import { registerDraftRoutes } from './http/routes/drafts.routes.ts';
import { registerEventRoutes } from './http/routes/events.routes.ts';
import { registerFolderRoutes } from './http/routes/folders.routes.ts';
import { registerLabelRoutes } from './http/routes/labels.routes.ts';
import { registerMessageRoutes } from './http/routes/messages.routes.ts';
import { registerSearchRoutes } from './http/routes/search.routes.ts';
import { registerSessionRoutes } from './http/routes/session.routes.ts';
import { registerSignatureRoutes } from './http/routes/signatures.routes.ts';
import { registerTemplateRoutes } from './http/routes/templates.routes.ts';
import { originGuard } from './http/middleware/csrf.ts';
import { registerErrorHandling } from './http/plugins/error-handler.ts';
import { generateRequestId, registerRequestContext } from './http/plugins/request-context.ts';
import { registerCors, registerSecurityHeaders } from './http/plugins/security.ts';
import { createRouteRegistrar } from './http/route-registry.ts';
import { AppError } from './application/index.ts';

export interface AppDependencies {
  readonly config: ServerConfig;
  readonly useCases: UseCases;
  readonly clock: Clock;
  /** Releases what the composition root created (event bus, later repositories). Called once from `app.close()`. */
  readonly shutdown: () => Promise<void>;
}

export interface AppOptions {
  /** Test hook: receive the structured log output instead of stdout. */
  readonly logStream?: { write(line: string): void };
}

export async function buildApp(deps: AppDependencies, options: AppOptions = {}): Promise<FastifyInstance> {
  const { config } = deps;

  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Safety net: nothing logs headers or bodies today, but credentials must never appear even by accident.
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]', 'res.headers["x-csrf-token"]', '*.password', '*.passwordHash', '*.token', '*.secret', '*.credential', '*.csrfToken'],
        censor: '[redacted]',
      },
      ...(options.logStream === undefined ? {} : { stream: options.logStream }),
    },
    // One access line per request is written by the request-context plugin instead of Fastify's own two.
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'requestId' }),
    genReqId: generateRequestId,
    trustProxy: config.trustProxy,
    bodyLimit: config.limits.jsonBodyBytes,
    requestTimeout: config.requestTimeoutMs,
    forceCloseConnections: 'idle',
    return503OnClosing: false, // the contract-shaped 503 below replaces Fastify's own body
    routerOptions: { maxParamLength: 1024 }, // ids are up to 256 chars, before percent-encoding
  });

  let closing = false;
  app.addHook('preClose', () => {
    closing = true;
  });
  // Responses finishing during shutdown end their keep-alive connection, so `close()` is not held by idle sockets.
  app.addHook('onSend', (_request, reply, payload, done) => {
    if (closing) void reply.header('connection', 'close');
    done(null, payload);
  });
  app.addHook('onClose', async () => {
    await deps.shutdown();
  });

  // Hooks run in registration order: CORS first (it answers preflights), then the shutdown gate, then identity.
  await registerCors(app, config);
  app.addHook('onRequest', (_request, reply, done) => {
    if (!closing) return done();
    void reply.header('connection', 'close');
    return done(new AppError('service_unavailable'));
  });
  registerSecurityHeaders(app, config);
  app.addHook('onRequest', originGuard(config.cors.allowedOrigins)); // CSRF layer 1: state-changing requests from foreign origins
  registerRequestContext(app, { resolveSession: deps.useCases.resolveSession, cookieName: config.cookie.name });
  registerErrorHandling(app, config);

  // The single multipart route reads its body itself later (streaming); it is never buffered by Fastify.
  app.addContentTypeParser('multipart/form-data', (_request, _payload, done) => done(null, undefined));

  registerHealthRoutes(app, { isClosing: () => closing });

  await app.register(
    (api, _opts, done) => {
      const { registrar, assertComplete } = createRouteRegistrar(api, config, { useCases: deps.useCases, clock: deps.clock });
      const u = deps.useCases;
      registerSessionRoutes(registrar, u);
      registerAccountRoutes(registrar, u);
      registerFolderRoutes(registrar, u);
      registerMessageRoutes(registrar, u);
      registerAttachmentRoutes(registrar, u);
      registerDraftRoutes(registrar, u);
      registerSearchRoutes(registrar, u);
      registerLabelRoutes(registrar, u);
      registerSignatureRoutes(registrar, u);
      registerTemplateRoutes(registrar, u);
      registerEventRoutes(registrar, u);
      assertComplete();
      done();
    },
    { prefix: config.apiPrefix },
  );

  return app;
}

/** Starts the HTTP server and owns its lifecycle (listen, graceful shutdown). */
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
import { compose, openPersistence } from './compose.ts';
import type { Composition, MailIntegrationOptions } from './compose.ts';
import type { ServerConfig, ServerSecrets } from './config/index.ts';

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly address: string;
  /** Startup notes from the composition root (no secrets). */
  readonly warnings: readonly string[];
  /** Stops accepting connections, lets in-flight requests finish (up to the timeout), releases resources. */
  close(): Promise<void>;
}

/** `composition` defaults to the production composition of `config` + `secrets`; tests pass their own. */
export async function startServer(
  config: ServerConfig,
  secrets: ServerSecrets = { credentialKeys: null },
  composition?: Composition,
  options?: { mail?: MailIntegrationOptions },
): Promise<RunningServer> {
  // Database first: if it cannot be opened or migrated, HTTP is never started.
  let resolved = composition;
  if (resolved === undefined) {
    const persistence = await openPersistence(config);
    try {
      const isTest = config.nodeEnv === 'test';
      const mailOptions: MailIntegrationOptions = options?.mail ?? {
        enabled: !isTest,
        validateOnAccountSave: !isTest,
        allowPrivateNetworks: config.nodeEnv !== 'production',
      };
      resolved = compose(config, { secrets, persistence, mail: mailOptions });
    } catch (error) {
      await persistence.close?.();
      throw error;
    }
  }
  const app = await buildApp(resolved);
  let address: string;
  try {
    address = await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close(); // releases the database connection
    throw error;
  }

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const timeout = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), config.shutdownTimeoutMs).unref();
      });
      // `app.close()` = stop listening, wait for in-flight requests, run onClose hooks (event bus).
      const outcome = await Promise.race([app.close().then(() => 'closed' as const), timeout]);
      if (outcome === 'timeout') {
        app.log.warn({ timeoutMs: config.shutdownTimeoutMs }, 'graceful shutdown timed out; closing remaining connections');
        app.server.closeAllConnections();
      }
    })();
    return closing;
  };

  return { app, address, warnings: resolved.warnings, close };
}

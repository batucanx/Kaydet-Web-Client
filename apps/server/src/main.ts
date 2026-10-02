/** Process entry point: read the environment ONCE, validate it, start, and wire signals to graceful shutdown. */
import { ConfigError, loadConfiguration } from './config/index.ts';
import { startServer } from './server.ts';

async function main(): Promise<void> {
  const { config, secrets } = loadConfiguration(process.env);
  const server = await startServer(config, secrets);
  for (const warning of server.warnings) server.app.log.warn(warning);
  server.app.log.info({ address: server.address, env: config.nodeEnv }, 'kaydet server listening');

  let signalled = false;
  const shutdown = (signal: string): void => {
    if (signalled) return; // a second signal does not restart shutdown
    signalled = true;
    server.app.log.info({ signal }, 'shutting down');
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        server.app.log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/** One line per link of the cause chain, no stack: what an operator needs (migration N failed, directory missing…). */
function describe(error: unknown): string {
  const lines: string[] = [];
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 4; current = current.cause, depth++) lines.push(current.message);
  return lines.length > 0 ? lines.join('\n  caused by: ') : String(error);
}

main().catch((error: unknown) => {
  // Startup failures (invalid configuration, database or migration problems, port in use) stop the process BEFORE any
  // request is served. Messages name variables, migration versions and paths — never values, credentials or data.
  console.error(error instanceof ConfigError ? error.message : `kaydet server failed to start: ${describe(error)}`);
  process.exit(1);
});

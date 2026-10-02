/** Real-socket lifecycle tests: listening, graceful shutdown with in-flight requests, shutdown timeout. */
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountRepository } from './application/index.ts';
import { startServer } from './server.ts';
import type { RunningServer } from './server.ts';
import { accountsWith, createTestApplication } from './testing/harness.ts';

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** A server on a random port whose account listing takes `delayMs`. */
async function start(delayMs: number, env: Record<string, string> = {}) {
  const holder: { repo?: AccountRepository } = {};
  const app = await createTestApplication({
    env: { PORT: '0', ...env },
    ports: {
      accounts: accountsWith({
        listByUser: async (userId) => {
          await sleep(delayMs);
          return holder.repo?.listByUser(userId) ?? [];
        },
      }),
    },
  });
  holder.repo = app.memory.accounts;
  running = await startServer(app.config, { credentialKeys: null }, app.composition);
  return { server: running, cookie: `${app.config.cookie.name}=${app.tokens.a}` };
}

describe('server lifecycle', () => {
  it('listens and serves /health', async () => {
    const { server } = await start(0);
    const res = await fetch(`${server.address}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('shutdown lets an in-flight request finish, then stops accepting connections', async () => {
    const { server, cookie } = await start(300);
    const inFlight = fetch(`${server.address}/api/accounts`, { headers: { cookie } });
    await sleep(80); // the request has reached the handler
    const closed = server.close();
    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(2);
    await closed;
    await expect(fetch(`${server.address}/health`)).rejects.toThrow();
  });

  it('close() is idempotent', async () => {
    const { server } = await start(0);
    await Promise.all([server.close(), server.close()]);
  });

  it('gives up after the shutdown timeout and closes remaining connections', async () => {
    const { server, cookie } = await start(3000, { SHUTDOWN_TIMEOUT_MS: '200' });
    const stuck = fetch(`${server.address}/api/accounts`, { headers: { cookie } }).then(
      () => 'completed',
      () => 'aborted',
    );
    await sleep(80);
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await stuck).toBe('aborted');
  });
});

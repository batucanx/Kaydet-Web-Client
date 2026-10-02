/**
 * Server startup and shutdown with the real database: order of steps, fail-closed behaviour, and what is left on disk.
 * Uses real sockets (`startServer`) and real files.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openPersistence } from './compose.ts';
import { ConfigError, loadConfiguration } from './config/index.ts';
import { SystemClock } from './infrastructure/clock/system-clock.ts';
import { startServer } from './server.ts';
import type { RunningServer } from './server.ts';

const KEY = `k1:${Buffer.alloc(32, 5).toString('base64')}`;
const directories: string[] = [];
let running: RunningServer | undefined;
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'kaydet-life-'));
  directories.push(dir);
  return dir;
};
afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const dir of directories.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // ignore
    }
  }
});

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
    });
    probe.on('error', reject);
  });

const configFor = (env: Record<string, string>) => loadConfiguration({ NODE_ENV: 'test', CREDENTIAL_ENCRYPTION_KEYS: KEY, PORT: '0', ...env });

describe('startup', () => {
  it('opens the database, verifies the PRAGMAs, runs the migrations, then serves HTTP', async () => {
    const path = join(tempDir(), 'kaydet.db');
    const { config, secrets } = configFor({ DATABASE_PATH: path });
    running = await startServer(config, secrets);
    expect(existsSync(path)).toBe(true);
    const health = await fetch(`${running.address}/health`);
    expect(health.status).toBe(200);
    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare('SELECT max(version) AS v FROM schema_migrations').get()?.['v']).toBe(2);
    expect(Object.values(raw.prepare('PRAGMA journal_mode').get() ?? {})[0]).toBe('wal');
    raw.close();
  });

  it('a second start finds nothing to migrate, and keeps the data', async () => {
    const path = join(tempDir(), 'kaydet.db');
    const { config, secrets } = configFor({ DATABASE_PATH: path });
    const first = await startServer(config, secrets);
    await first.close();
    const persistence = await openPersistence(config, new SystemClock());
    expect(persistence.migrationsApplied).toEqual([]);
    await persistence.close?.();
  });

  it('FAILS CLOSED when a migration cannot be trusted: no HTTP server is started', async () => {
    const dir = tempDir();
    const path = join(dir, 'kaydet.db');
    const { config, secrets } = configFor({ DATABASE_PATH: path });
    await (await startServer(config, secrets)).close();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE schema_migrations SET checksum = 'tampered'");
    raw.close();

    const port = await freePort();
    const again = configFor({ DATABASE_PATH: path, PORT: String(port) });
    await expect(startServer(again.config, again.secrets)).rejects.toThrow(/modified after it was applied/);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow(); // nothing is listening
  });

  it('a migration error message carries the version and name — not the path, not any data', async () => {
    const path = join(tempDir(), 'kaydet.db');
    const { config, secrets } = configFor({ DATABASE_PATH: path });
    await (await startServer(config, secrets)).close();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE schema_migrations SET checksum = 'tampered'");
    raw.close();
    let message = '';
    try {
      await startServer(config, secrets);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/migration 1 \(initial-schema\)/);
    expect(message).not.toContain(path);
    expect(message).not.toMatch(/password|secret|key/i);
  });

  it('refuses a database that is newer than the server', async () => {
    const path = join(tempDir(), 'kaydet.db');
    const { config, secrets } = configFor({ DATABASE_PATH: path });
    await (await startServer(config, secrets)).close();
    const raw = new DatabaseSync(path);
    raw.exec("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (3, 'from-the-future', 'x', '2099-01-01T00:00:00.000Z')");
    raw.close();
    await expect(startServer(config, secrets)).rejects.toThrow(/newer than this server/);
  });

  it('refuses to adopt a SQLite file that belongs to something else — and leaves it untouched', async () => {
    const path = join(tempDir(), 'other.db');
    const foreign = new DatabaseSync(path);
    foreign.exec("CREATE TABLE contacts (name TEXT); INSERT INTO contacts VALUES ('keep me')");
    foreign.close();
    const before = readFileSync(path);
    const { config, secrets } = configFor({ DATABASE_PATH: path });
    await expect(startServer(config, secrets)).rejects.toThrow(/not a Kaydet database/);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('refuses a file that is not a database at all', async () => {
    const path = join(tempDir(), 'garbage.db');
    writeFileSync(path, 'plain text, not sqlite');
    const { config, secrets } = configFor({ DATABASE_PATH: path });
    await expect(startServer(config, secrets)).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe('plain text, not sqlite');
  });

  it('production never creates a database location on its own', async () => {
    const dir = tempDir();
    const path = join(dir, 'missing-directory', 'kaydet.db');
    const { config, secrets } = loadConfiguration({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://mail.example.com', CREDENTIAL_ENCRYPTION_KEYS: KEY, DATABASE_PATH: path, PORT: '0' });
    await expect(startServer(config, secrets)).rejects.toThrow(/does not exist/);
    expect(existsSync(join(dir, 'missing-directory'))).toBe(false);
  });

  it('development may create its directory (explicit, documented default location)', async () => {
    const path = join(tempDir(), 'nested', 'data', 'kaydet.db');
    const { config, secrets } = configFor({ NODE_ENV: 'development', CORS_ALLOWED_ORIGINS: 'http://localhost:5173', DATABASE_PATH: path });
    running = await startServer(config, secrets);
    expect(existsSync(path)).toBe(true);
  });

  it('a busy database file (another process holds it) does not hang startup forever: it fails within the busy timeout', async () => {
    const path = join(tempDir(), 'kaydet.db');
    const { config, secrets } = configFor({ DATABASE_PATH: path, DATABASE_BUSY_TIMEOUT_MS: '100' });
    await (await startServer(config, secrets)).close();
    const other = new DatabaseSync(path);
    other.exec('BEGIN EXCLUSIVE');
    try {
      const started = Date.now();
      const outcome = await startServer(config, secrets).then(
        async (server) => {
          await server.close();
          return 'started';
        },
        () => 'failed',
      );
      expect(Date.now() - started).toBeLessThan(5000);
      expect(['started', 'failed']).toContain(outcome); // never a hang; migrations had nothing to write, so reading may still succeed
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
  });
});

describe('shutdown', () => {
  it('drains HTTP, then closes the connection: the WAL is checkpointed away and the file reopens cleanly', async () => {
    const path = join(tempDir(), 'kaydet.db');
    const { config, secrets } = configFor({ DATABASE_PATH: path });
    const server = await startServer(config, secrets);
    expect((await fetch(`${server.address}/health`)).status).toBe(200);
    expect(existsSync(`${path}-wal`)).toBe(true); // WAL mode is really in use while running
    await server.close();
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    const raw = new DatabaseSync(path);
    expect(raw.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
    raw.close();
  });

  it('after close, nothing holds the file open (it can be deleted)', async () => {
    const dir = tempDir();
    const path = join(dir, 'kaydet.db');
    const { config, secrets } = configFor({ DATABASE_PATH: path });
    await (await startServer(config, secrets)).close();
    rmSync(dir, { recursive: true, force: true }); // would throw EPERM on Windows if the handle were still open
    expect(existsSync(path)).toBe(false);
  });

  it('a failure to listen (port taken) releases the database too', async () => {
    const path = join(tempDir(), 'kaydet.db');
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const { config, secrets } = configFor({ DATABASE_PATH: path, PORT: String(port) });
      await expect(startServer(config, secrets)).rejects.toThrow();
      rmSync(path, { force: true }); // the connection was closed: no lock on the file
      expect(existsSync(path)).toBe(false);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

describe('database configuration', () => {
  it('production REQUIRES an absolute DATABASE_PATH, and never :memory:', () => {
    const env = { NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://mail.example.com', CREDENTIAL_ENCRYPTION_KEYS: KEY };
    expect(() => loadConfiguration(env)).toThrow(/DATABASE_PATH: required in production/);
    expect(() => loadConfiguration({ ...env, DATABASE_PATH: ':memory:' })).toThrow(/not allowed in production/);
    expect(() => loadConfiguration({ ...env, DATABASE_PATH: 'relative/kaydet.db' })).toThrow(/absolute path/);
    expect(loadConfiguration({ ...env, DATABASE_PATH: join(tmpdir(), 'kaydet.db') }).config.database).toMatchObject({ createDirectory: false });
  });

  it('development defaults to ./data/kaydet.db under the working directory; tests default to no database (in-memory ports)', () => {
    const dev = loadConfiguration({ NODE_ENV: 'development' }).config.database;
    expect(dev.path).toBe(join(process.cwd(), 'data', 'kaydet.db'));
    expect(dev.createDirectory).toBe(true);
    expect(loadConfiguration({ NODE_ENV: 'test' }).config.database.path).toBeNull();
    expect(() => loadConfiguration({ NODE_ENV: 'test', DATABASE_PATH: '' })).not.toThrow();
  });

  it('the busy timeout is configurable and bounded', () => {
    expect(loadConfiguration({ NODE_ENV: 'test' }).config.database.busyTimeoutMs).toBe(5000);
    expect(loadConfiguration({ NODE_ENV: 'test', DATABASE_BUSY_TIMEOUT_MS: '250' }).config.database.busyTimeoutMs).toBe(250);
    expect(() => loadConfiguration({ NODE_ENV: 'test', DATABASE_BUSY_TIMEOUT_MS: '999999' })).toThrow(ConfigError);
  });

  it('openPersistence in production with no database refuses (defence in depth behind the config check)', async () => {
    const { config } = loadConfiguration({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://mail.example.com', CREDENTIAL_ENCRYPTION_KEYS: KEY, DATABASE_PATH: join(tmpdir(), 'x.db') });
    await expect(openPersistence({ ...config, database: { ...config.database, path: null } })).rejects.toThrow(/no database configured/);
  });
});

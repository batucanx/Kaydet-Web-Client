/**
 * SQLite-backed test application: the same fixtures as the in-memory one, written through the PORTS into a real database
 * file (so the whole stack — repositories, migrations, transactions, FTS — is what production runs).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../app.ts';
import { grantAccountAccess } from '../application/context/authorized-account.ts';
import type { ApplicationPorts } from '../application/index.ts';
import { compose } from '../compose.ts';
import { loadConfiguration } from '../config/index.ts';
import { createMemoryPersistence } from '../infrastructure/memory/index.ts';
import { openSqlite } from '../infrastructure/sqlite/index.ts';
import type { SqlitePersistence } from '../infrastructure/sqlite/index.ts';
import { NodeSessionSecrets } from '../infrastructure/security/node-session-secrets.ts';
import { IDS, USER_A, USER_B, seed } from './fixtures.ts';
import { FakeClock, RecordingEventBus, SEED_IDENTIFIERS, SEED_PASSWORD, makeRequester } from './harness.ts';
import { Argon2PasswordHasher } from '../infrastructure/security/argon2-password-hasher.ts';
import type { StoredFolder } from '../application/ports/repositories/mail-store.ts';

/** Server paths of the fixture folders (the tree is DERIVED from them, exactly as the mobile app does). */
const FOLDER_PATHS: Record<string, { path: string; delimiter: string; sortOrder: number }> = {
  [IDS.a1Inbox]: { path: 'INBOX', delimiter: '.', sortOrder: 0 },
  [IDS.a1Trash]: { path: 'Trash', delimiter: '.', sortOrder: 40 },
  [IDS.a1Drafts]: { path: 'Drafts', delimiter: '.', sortOrder: 20 },
  [IDS.a1Custom]: { path: 'Projeler', delimiter: '.', sortOrder: 100 },
  [IDS.a1Parent]: { path: 'Arsivim', delimiter: '.', sortOrder: 100 },
  [IDS.a1Child]: { path: 'Arsivim.Alt', delimiter: '.', sortOrder: 100 },
  [IDS.a2Inbox]: { path: 'INBOX', delimiter: '.', sortOrder: 0 },
  [IDS.b1Inbox]: { path: 'INBOX', delimiter: '.', sortOrder: 0 },
};

const TEST_KEY = `k1:${Buffer.alloc(32, 9).toString('base64')}`;

let seedHash: Promise<string> | undefined;
const passwordHash = () => (seedHash ??= new Argon2PasswordHasher().hash(SEED_PASSWORD));

export interface SqliteTestOptions {
  /** Reuse this database file (a "restart"). Default: a fresh temporary file. */
  readonly path?: string;
  readonly env?: Record<string, string>;
  /** Write the standard fixtures (default true). Never done when reopening a file that already has users. */
  readonly seed?: boolean;
  readonly clock?: FakeClock;
  /** Tokens of an earlier run against the same file (sessions persist; new ones are issued otherwise). */
  readonly tokens?: { a: string; b: string };
  /** Replace ports (a failing crypto, a failing session repository…) to provoke failures inside use-case transactions. */
  readonly ports?: Partial<ApplicationPorts>;
}

export async function createSqliteTestApplication(options: SqliteTestOptions = {}) {
  const ownedDirectory = options.path === undefined ? mkdtempSync(join(tmpdir(), 'kaydet-db-')) : null;
  const path = options.path ?? join(ownedDirectory as string, 'kaydet.db');
  const { config, secrets: serverSecrets } = loadConfiguration({ NODE_ENV: 'test', CREDENTIAL_ENCRYPTION_KEYS: TEST_KEY, ...options.env });
  const clock = options.clock ?? new FakeClock();
  const persistence = await openSqlite({ path, clock, busyTimeoutMs: 2000 });
  const events = new RecordingEventBus();
  const secrets = new NodeSessionSecrets();

  const fresh = (await persistence.users.findByIdentifier(SEED_IDENTIFIERS.a)) === null;
  if (options.seed !== false && fresh) await seedSqlite(persistence, clock);

  const composition = compose(config, { secrets: serverSecrets, persistence, ports: { clock, events, ...options.ports } });
  const tokens = options.tokens ?? {
    a: (await composition.services.auth.issueSession(USER_A)).token,
    b: (await composition.services.auth.issueSession(USER_B)).token,
  };
  return {
    config,
    clock,
    persistence,
    path,
    events,
    secrets,
    composition,
    services: composition.services,
    useCases: composition.useCases,
    tokens,
    /** Access proof for tests that talk to repositories directly. */
    access: (accountId: string, userId: string) => grantAccountAccess({ id: accountId, userId, email: `${accountId}@example.test` }),
    /** Closes the connection (if the app has not) and removes the temporary directory this call created. */
    cleanup: async () => {
      if (persistence.db.isOpen) await persistence.close();
      if (ownedDirectory !== null) rmSync(ownedDirectory, { recursive: true, force: true });
    },
  };
}
export type SqliteTestApplication = Awaited<ReturnType<typeof createSqliteTestApplication>>;

/** Users (real Argon2id hash), accounts, folders and messages of the standard fixtures, written through the ports. */
export async function seedSqlite(p: SqlitePersistence, clock: FakeClock): Promise<void> {
  const source = createMemoryPersistence();
  seed(source);
  const hash = await passwordHash();
  for (const [id, identifier] of [[USER_A, SEED_IDENTIFIERS.a], [USER_B, SEED_IDENTIFIERS.b]] as const) {
    await p.users.create({ id, identifier, passwordHash: hash, createdAt: clock.now(), updatedAt: clock.now() });
  }
  await p.transactions.run(async () => {
    for (const { userId, account } of source.store.accounts) await p.accounts.create(userId, account);
    for (const f of source.store.folders) {
      const meta = FOLDER_PATHS[f.id];
      if (meta === undefined) throw new Error(`fixture folder ${f.id} has no path`);
      const stored: StoredFolder = {
        id: f.id,
        name: f.name,
        role: f.role,
        sortOrder: meta.sortOrder,
        isFavorite: f.isFavorite,
        provider: { path: meta.path, delimiter: meta.delimiter, uidValidity: null, uidNext: null, highestModSeq: null },
      };
      await p.mailStore.upsertFolder(grantAccountAccess({ id: f.accountId, userId: source.store.ownerOf(f.accountId) as string, email: 'x' }), stored);
    }
    for (const m of source.store.messages) {
      const owner = source.store.ownerOf(m.accountId) as string;
      await p.mailStore.upsertMessage(grantAccountAccess({ id: m.accountId, userId: owner, email: 'x' }), { message: m, provider: null });
    }
  });
}

export async function createSqliteHarness(options: SqliteTestOptions = {}) {
  const application = await createSqliteTestApplication(options);
  const logLines: string[] = [];
  const app = await buildApp(application.composition, { logStream: { write: (line) => void logLines.push(line) } });
  await app.ready();
  const request = makeRequester(app, application);
  return {
    ...application,
    app,
    logLines,
    request,
    /** Stops HTTP and closes the database (composition shutdown), but keeps the file for a restart. */
    stop: () => app.close(),
    close: async () => {
      await app.close();
      await application.cleanup();
    },
  };
}
export type SqliteHarness = Awaited<ReturnType<typeof createSqliteHarness>>;

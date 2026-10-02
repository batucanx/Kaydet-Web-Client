import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Clock } from '../../application/index.ts';
import { MemoryBlobStorage } from '../memory/memory-blob-storage.ts';
import { SqliteAccountRepository, SqliteFolderRepository } from './account-repositories.ts';
import { SqliteDatabase } from './database.ts';
import { SqliteDraftRepository, SqliteOutboxRepository } from './draft-repositories.ts';
import { SqliteMailStore } from './mail-store.ts';
import { SqliteMessageRepository } from './message-repository.ts';
import { migrate } from './migrator.ts';
import type { MigrationReport } from './migrator.ts';
import { migrations } from './migrations/index.ts';
import { SqliteLabelRepository, SqliteSignatureRepository, SqliteTemplateRepository } from './personalisation-repositories.ts';
import { SqliteCredentialRepository, SqliteSessionRepository, SqliteUserRepository } from './security-repositories.ts';
import { SqliteUnitOfWork } from './unit-of-work.ts';

import { SqliteSyncStateRepository } from './sync-state-repository.ts';

/** Every persistence port, backed by one SQLite connection. */
export function createSqlitePersistence(db: SqliteDatabase, clock: Clock) {
  return {
    db,
    users: new SqliteUserRepository(db),
    sessions: new SqliteSessionRepository(db),
    accounts: new SqliteAccountRepository(db, clock),
    credentialRecords: new SqliteCredentialRepository(db),
    folders: new SqliteFolderRepository(db),
    messages: new SqliteMessageRepository(db),
    mailStore: new SqliteMailStore(db, clock),
    drafts: new SqliteDraftRepository(db, clock),
    outbox: new SqliteOutboxRepository(db, clock),
    labels: new SqliteLabelRepository(db, clock),
    signatures: new SqliteSignatureRepository(db, clock),
    templates: new SqliteTemplateRepository(db, clock),
    transactions: new SqliteUnitOfWork(db),
    syncState: new SqliteSyncStateRepository(db, clock),
    // Attachment BYTES are not stored yet (metadata only, in SQLite). Blob storage is a later phase; until then this
    // non-durable adapter keeps the port satisfied.
    blobs: new MemoryBlobStorage(),
    close: () => db.close(),
  };
}
export type SqlitePersistence = ReturnType<typeof createSqlitePersistence>;

export interface OpenSqliteOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
  readonly clock: Clock;
  /** Create the parent directory if it is missing. Development only: production never creates a location on its own. */
  readonly createDirectory?: boolean;
}

/**
 * Startup sequence: open → PRAGMAs (verified) → identity check → migrations. ANY failure closes the connection and
 * throws; the caller must not start the HTTP server. The database is never dropped, truncated or recreated here.
 */
export async function openSqlite(options: OpenSqliteOptions): Promise<SqlitePersistence & { migration: MigrationReport }> {
  if (options.path !== ':memory:') {
    const directory = dirname(options.path);
    if (!existsSync(directory)) {
      if (options.createDirectory !== true) throw new Error('the database directory does not exist (it is not created automatically)');
      mkdirSync(directory, { recursive: true });
    }
  }
  const db = SqliteDatabase.open({ path: options.path, ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }) });
  try {
    const migration = await migrate(db, migrations, () => options.clock.now());
    return { ...createSqlitePersistence(db, options.clock), migration };
  } catch (error) {
    await db.close();
    throw error;
  }
}

export { SqliteDatabase, DatabaseError, APPLICATION_ID } from './database.ts';
export { migrate, MigrationError, checksumOf } from './migrator.ts';
export type { Migration } from './migrator.ts';
export { migrations } from './migrations/index.ts';

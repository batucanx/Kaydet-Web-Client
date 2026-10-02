/**
 * Schema migrations.
 *
 *  - Migrations are an ordered list (`migrations/index.ts`), versions 1, 2, 3… with no gaps, each a fixed SQL script.
 *  - Applied versions are recorded in `schema_migrations` (version, name, checksum, applied_at) IN THE SAME TRANSACTION as
 *    the script, so a migration is either fully applied and recorded or not applied at all.
 *  - IMMUTABLE once released: the SHA-256 of each script is stored, and startup REFUSES to run if an applied migration's
 *    script has changed since (fix mistakes with a NEW migration).
 *  - The database must not be NEWER than the code (an older server must not touch a newer schema) and must not have
 *    gaps.
 *  - Failure stops startup: the caller (`openPersistence`) does not go on to start HTTP. The error names the version and
 *    the migration, never data.
 *  - Nothing here creates or drops anything outside a listed migration, and no migration is destructive unless it says so
 *    in its own script and is reviewed as such.
 */
import { createHash } from 'node:crypto';
import type { SqliteDatabase } from './database.ts';

export interface Migration {
  readonly version: number;
  readonly name: string;
  /** Plain SQL, several statements allowed. Deterministic: no clock, no randomness. */
  readonly sql: string;
}

export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

export const checksumOf = (migration: Migration): string => createHash('sha256').update(migration.sql, 'utf8').digest('hex');

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

export interface MigrationReport {
  /** Versions applied by THIS call. */
  readonly applied: readonly number[];
  /** Highest version present afterwards. */
  readonly current: number;
}

function validateList(migrations: readonly Migration[]): void {
  migrations.forEach((m, index) => {
    if (m.version !== index + 1) throw new MigrationError(`migration list is not sequential: expected version ${index + 1}, found ${m.version}`);
  });
}

export async function migrate(db: SqliteDatabase, migrations: readonly Migration[], now: () => Date): Promise<MigrationReport> {
  validateList(migrations);

  const bookkeeping = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'");
  if (bookkeeping === undefined) {
    // The one table that exists before any migration: it records the migrations themselves.
    await db.exec(`CREATE TABLE schema_migrations (
      version INTEGER NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT`);
  }

  const applied = await db.all<AppliedRow & Record<string, unknown>>('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
  applied.forEach((row, index) => {
    if (row.version !== index + 1) throw new MigrationError(`schema_migrations has a gap at version ${index + 1}`);
    const known = migrations[index];
    if (known === undefined) {
      throw new MigrationError(`the database is at migration ${row.version}, newer than this server (${migrations.length}); refusing to start with an older server`);
    }
    if (known.name !== row.name || checksumOf(known) !== row.checksum) {
      throw new MigrationError(`migration ${row.version} (${row.name}) was modified after it was applied; released migrations are immutable — add a new migration instead`);
    }
  });

  const done: number[] = [];
  for (const migration of migrations.slice(applied.length)) {
    try {
      await db.transaction(async () => {
        await db.exec(migration.sql);
        await db.run('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)', [
          migration.version,
          migration.name,
          checksumOf(migration),
          now().toISOString(),
        ]);
      });
    } catch (error) {
      throw new MigrationError(`migration ${migration.version} (${migration.name}) failed and was rolled back`, { cause: error });
    }
    done.push(migration.version);
  }
  return { applied: done, current: migrations.length };
}

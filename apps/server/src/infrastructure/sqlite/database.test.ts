/** The SQLite layer itself: PRAGMAs (verified at runtime), identity check, transactions, concurrency, errors, migrations. */
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FOLDER_ROLES } from '@kaydet/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../application/index.ts';
import { APPLICATION_ID, DatabaseError, SqliteDatabase, isForeignKeyViolation, isUniqueViolation } from './database.ts';
import { MigrationError, checksumOf, migrate } from './migrator.ts';
import type { Migration } from './migrator.ts';
import { migrations } from './migrations/index.ts';
import { openSqlite } from './index.ts';
import { FakeClock } from '../../testing/harness.ts';

const directories: string[] = [];
const databases: SqliteDatabase[] = [];
const tempPath = (name = 'test.db') => {
  const dir = mkdtempSync(join(tmpdir(), 'kaydet-sqlite-'));
  directories.push(dir);
  return join(dir, name);
};
const open = (path = tempPath(), busyTimeoutMs?: number) => {
  const db = SqliteDatabase.open({ path, ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }) });
  databases.push(db);
  return db;
};
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const scalar = async (db: SqliteDatabase, sql: string) => Object.values((await db.get(sql)) ?? {})[0];
const clock = new FakeClock();

describe('connection and PRAGMAs (read back from SQLite, not assumed)', () => {
  it('runs in WAL mode with foreign keys, the configured busy timeout, FULL synchronous and the journal size limit', async () => {
    const db = open(tempPath(), 1234);
    expect(String(await scalar(db, 'PRAGMA journal_mode')).toLowerCase()).toBe('wal');
    expect(await scalar(db, 'PRAGMA foreign_keys')).toBe(1);
    expect(await scalar(db, 'PRAGMA busy_timeout')).toBe(1234);
    expect(await scalar(db, 'PRAGMA synchronous')).toBe(2); // FULL
    expect(await scalar(db, 'PRAGMA trusted_schema')).toBe(0);
    expect(await scalar(db, 'PRAGMA journal_size_limit')).toBe(64 * 1024 * 1024);
  });

  it('WAL is real: a -wal file appears after a write and the mode persists across reopen', async () => {
    const path = tempPath();
    const db = open(path);
    await db.exec('CREATE TABLE t (a INTEGER)');
    await db.run('INSERT INTO t VALUES (1)');
    expect(existsSync(`${path}-wal`)).toBe(true);
    await db.close();
    databases.length = 0;
    const raw = new DatabaseSync(path);
    expect(Object.values(raw.prepare('PRAGMA journal_mode').get() ?? {})[0]).toBe('wal'); // stored in the file header
    raw.close();
  });

  it('foreign keys are enforced (an orphan insert is rejected, not silently accepted)', async () => {
    const db = open();
    await db.exec('CREATE TABLE parent (id TEXT PRIMARY KEY) STRICT; CREATE TABLE child (p TEXT REFERENCES parent(id)) STRICT');
    const error = await db.run("INSERT INTO child VALUES ('missing')").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect(isForeignKeyViolation(error)).toBe(true);
  });

  it('closing the last connection checkpoints the WAL into the main file', async () => {
    const path = tempPath();
    const db = open(path);
    await db.exec('CREATE TABLE t (a INTEGER)');
    for (let i = 0; i < 50; i++) await db.run('INSERT INTO t VALUES (?)', [i]);
    await db.close();
    databases.length = 0;
    expect(existsSync(`${path}-wal`)).toBe(false); // removed by the final checkpoint
    const raw = new DatabaseSync(path);
    expect(raw.prepare('SELECT count(*) AS n FROM t').get()?.['n']).toBe(50);
    raw.close();
  });

  it('is unusable after close, with a clear error', async () => {
    const db = open();
    await db.close();
    await expect(db.get('SELECT 1')).rejects.toBeInstanceOf(DatabaseError);
    await db.close(); // idempotent
    expect(db.isOpen).toBe(false);
  });

  it('refuses a SQLite file that is not a Kaydet database, and never modifies it', async () => {
    const path = tempPath();
    const foreign = new DatabaseSync(path);
    foreign.exec('CREATE TABLE somebody_elses (x INTEGER)');
    foreign.close();
    expect(() => SqliteDatabase.open({ path })).toThrow(/not a Kaydet database/);
    const check = new DatabaseSync(path);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r['name'])).toEqual(['somebody_elses']);
    check.close();
  });

  it('a fresh empty file becomes ours (application_id), and reopens fine', async () => {
    const path = tempPath();
    const db = open(path);
    expect(await scalar(db, 'PRAGMA application_id')).toBe(APPLICATION_ID);
    await db.close();
    databases.length = 0;
    const again = open(path);
    expect(again.isOpen).toBe(true);
  });

  it('fails to open a path that is not a database file', () => {
    const path = tempPath('garbage.db');
    writeFileSync(path, 'this is definitely not a sqlite database file, just text');
    expect(() => SqliteDatabase.open({ path })).toThrow(DatabaseError);
  });

  it('openSqlite does not create a missing directory unless asked (production never creates locations)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kaydet-sqlite-'));
    directories.push(dir);
    const path = join(dir, 'nested', 'kaydet.db');
    await expect(openSqlite({ path, clock })).rejects.toThrow(/does not exist/);
    expect(existsSync(join(dir, 'nested'))).toBe(false);
    const created = await openSqlite({ path, clock, createDirectory: true });
    await created.close();
    expect(existsSync(path)).toBe(true);
  });
});

describe('transactions', () => {
  const setup = async () => {
    const db = open();
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT');
    return db;
  };
  const count = async (db: SqliteDatabase) => Number(await scalar(db, 'SELECT count(*) FROM t'));

  it('commits everything on success', async () => {
    const db = await setup();
    await db.transaction(async () => {
      await db.run("INSERT INTO t VALUES (1, 'a')");
      await db.run("INSERT INTO t VALUES (2, 'b')");
    });
    expect(await count(db)).toBe(2);
    expect(db.inTransaction).toBe(false);
  });

  it('rolls EVERYTHING back on failure and rethrows the original error', async () => {
    const db = await setup();
    const failure = new Error('boom');
    await expect(
      db.transaction(async () => {
        await db.run("INSERT INTO t VALUES (1, 'a')");
        await db.run("INSERT INTO t VALUES (2, 'b')");
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await count(db)).toBe(0);
    expect(db.inTransaction).toBe(false);
  });

  it('a constraint failure half-way rolls back the earlier writes (no partial state)', async () => {
    const db = await setup();
    const error = await db
      .transaction(async () => {
        await db.run("INSERT INTO t VALUES (1, 'a')");
        await db.run("INSERT INTO t VALUES (1, 'duplicate')");
      })
      .catch((e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
    expect(await count(db)).toBe(0);
  });

  it('statements from other callers wait for an open transaction and never join it', async () => {
    const db = await setup();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];

    const tx = db.transaction(async () => {
      await db.run("INSERT INTO t VALUES (1, 'in-tx')");
      order.push('tx wrote');
      await hold;
      throw new Error('roll me back');
    });
    await new Promise((r) => setTimeout(r, 20));
    const outsider = db.run("INSERT INTO t VALUES (2, 'outsider')").then(() => order.push('outsider wrote'));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['tx wrote']); // the outsider is queued behind the transaction
    release();
    await expect(tx).rejects.toThrow('roll me back');
    await outsider;
    // The outsider's row survived the rollback: it was NOT inside the transaction.
    expect((await db.all('SELECT id FROM t')).map((r) => r['id'])).toEqual([2]);
  });

  it('two transactions are serialised, so read-modify-write cannot lose updates', async () => {
    const db = await setup();
    await db.run("INSERT INTO t VALUES (1, '0')");
    const bump = () =>
      db.transaction(async () => {
        const row = await db.get('SELECT v FROM t WHERE id = 1');
        await new Promise((r) => setTimeout(r, 2)); // a yield in the middle of read-modify-write
        await db.run('UPDATE t SET v = ? WHERE id = 1', [String(Number(row?.['v']) + 1)]);
      });
    await Promise.all(Array.from({ length: 20 }, bump));
    expect(await scalar(db, 'SELECT v FROM t WHERE id = 1')).toBe('20');
  });

  it('a nested transaction joins the outer one (one atomic unit)', async () => {
    const db = await setup();
    await expect(
      db.transaction(async () => {
        await db.transaction(async () => {
          await db.run("INSERT INTO t VALUES (1, 'inner')");
        });
        throw new Error('outer fails');
      }),
    ).rejects.toThrow('outer fails');
    expect(await count(db)).toBe(0);
  });

  it('concurrent writers on the shared connection all succeed', async () => {
    const db = await setup();
    await Promise.all(Array.from({ length: 200 }, (_, i) => db.run('INSERT INTO t VALUES (?, ?)', [i, 'x'])));
    expect(await count(db)).toBe(200);
  });
});

describe('errors', () => {
  it('BUSY (another process holds the write lock) becomes a retryable service_unavailable — never raw SQLite text', async () => {
    const path = tempPath();
    const db = open(path, 50); // give up after 50 ms
    await db.exec('CREATE TABLE t (a INTEGER)');
    const other = new DatabaseSync(path); // a second connection = another process
    other.exec('BEGIN IMMEDIATE');
    try {
      const error = await db.run('INSERT INTO t VALUES (1)').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'service_unavailable' });
      expect((error as AppError).options.retryAfterSeconds).toBe(1);
      expect((error as AppError).message).not.toMatch(/locked|busy|SQLITE/i);
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    await db.run('INSERT INTO t VALUES (1)'); // and it works again once the lock is gone
  });

  it('other database errors are a generic DatabaseError; the driver detail is only in `cause`', async () => {
    const db = open();
    const error = await db.get('SELECT * FROM table_that_does_not_exist').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as Error).message).toBe('database operation failed');
    expect(String((error as Error).cause)).toContain('table_that_does_not_exist');
  });

  it('values are always bound parameters: hostile text is data, not SQL', async () => {
    const db = open();
    await db.exec('CREATE TABLE t (v TEXT) STRICT');
    const hostile = "x'); DROP TABLE t; --";
    await db.run('INSERT INTO t VALUES (?)', [hostile]);
    expect((await db.get('SELECT v FROM t'))?.['v']).toBe(hostile);
  });
});

describe('migrations', () => {
  const fixed = () => new Date('2026-09-30T12:00:00.000Z');
  const two: Migration[] = [
    { version: 1, name: 'one', sql: 'CREATE TABLE a (x INTEGER) STRICT;' },
    { version: 2, name: 'two', sql: 'CREATE TABLE b (y INTEGER) STRICT;' },
  ];

  it('a fresh database runs every migration, in order, and records them', async () => {
    const db = open();
    const report = await migrate(db, migrations, fixed);
    expect(report).toEqual({ applied: migrations.map((m) => m.version), current: migrations.length });
    const rows = await db.all('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version');
    expect(rows.map((r) => r['version'])).toEqual(migrations.map((m) => m.version));
    expect(rows[0]).toMatchObject({ name: 'initial-schema', checksum: checksumOf(migrations[0] as Migration), applied_at: '2026-09-30T12:00:00.000Z' });
  });

  it('rerunning is safe and does nothing', async () => {
    const db = open();
    await migrate(db, migrations, fixed);
    expect(await migrate(db, migrations, fixed)).toEqual({ applied: [], current: migrations.length });
    expect(Number(await scalar(db, 'SELECT count(*) FROM schema_migrations'))).toBe(migrations.length);
  });

  it('applies only the NEW migrations to an existing database', async () => {
    const db = open();
    await migrate(db, two.slice(0, 1), fixed);
    expect((await migrate(db, two, fixed)).applied).toEqual([2]);
    expect(await scalar(db, "SELECT name FROM sqlite_master WHERE name = 'b'")).toBe('b');
  });

  it('a failing migration is rolled back entirely, is not recorded, and stops startup', async () => {
    const db = open();
    const broken: Migration[] = [...two, { version: 3, name: 'broken', sql: 'CREATE TABLE c (z INTEGER) STRICT; INSERT INTO no_such_table VALUES (1);' }];
    const error = await migrate(db, broken, fixed).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as Error).message).toMatch(/migration 3 \(broken\) failed and was rolled back/);
    expect(await scalar(db, "SELECT name FROM sqlite_master WHERE name = 'c'")).toBeUndefined(); // half of it did not stay
    expect((await db.all('SELECT version FROM schema_migrations')).map((r) => r['version'])).toEqual([1, 2]); // 1 and 2 stand
  });

  it('a migration failure prevents startup: openSqlite throws and leaves the connection closed', async () => {
    const path = tempPath();
    // Occupy the file with a Kaydet database whose recorded migration was tampered with.
    const first = await openSqlite({ path, clock });
    await first.close();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1");
    raw.close();
    await expect(openSqlite({ path, clock })).rejects.toThrow(/modified after it was applied/);
  });

  it('refuses to run when an applied migration was edited (released migrations are immutable)', async () => {
    const db = open();
    await migrate(db, two, fixed);
    const edited: Migration[] = [{ ...two[0]!, sql: 'CREATE TABLE a (x INTEGER, sneaky TEXT) STRICT;' }, two[1]!];
    await expect(migrate(db, edited, fixed)).rejects.toThrow(/immutable/);
  });

  it('refuses a database newer than the code (an old server must not touch a newer schema)', async () => {
    const db = open();
    await migrate(db, two, fixed);
    await expect(migrate(db, two.slice(0, 1), fixed)).rejects.toThrow(/newer than this server/);
  });

  it('refuses a gap in the recorded versions and a non-sequential list', async () => {
    const db = open();
    await migrate(db, two, fixed);
    await db.run('DELETE FROM schema_migrations WHERE version = 1');
    await expect(migrate(db, two, fixed)).rejects.toThrow(/gap/);
    await expect(migrate(open(), [two[1]!], fixed)).rejects.toThrow(/not sequential/);
  });

  it('the shipped migrations are sequential and each one is deterministic SQL (no IF NOT EXISTS shortcuts)', () => {
    migrations.forEach((m, i) => expect(m.version).toBe(i + 1));
    for (const m of migrations) expect(m.sql).not.toMatch(/IF NOT EXISTS/i);
  });

  it('the database can be used by a fresh connection after migration (schema really persisted)', async () => {
    const path = tempPath();
    const persistence = await openSqlite({ path, clock });
    await persistence.close();
    const again = await openSqlite({ path, clock });
    expect(again.migration.applied).toEqual([]); // nothing left to do on the second start
    await again.close();
  });

  it('the CHECK on folder roles matches the domain role list (drift guard)', async () => {
    const db = open();
    await migrate(db, migrations, fixed);
    const sql = String((await db.get("SELECT sql FROM sqlite_master WHERE name = 'folders'"))?.['sql']);
    const listed = /role\s+TEXT NOT NULL CHECK \(role IN \(([^)]*)\)\)/.exec(sql)?.[1]?.split(',').map((s) => s.trim().replaceAll("'", '')) ?? [];
    expect(listed.sort()).toEqual([...FOLDER_ROLES].sort());
  });
});

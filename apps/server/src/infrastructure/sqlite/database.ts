/**
 * The SQLite connection: the ONLY module that touches `node:sqlite`.
 *
 * Why `node:sqlite` (Node's built-in driver, bundled SQLite 3.5x with FTS5): no native addon to compile, no third-party
 * package to trust or patch, and the same choice as Phase 4's Argon2 — the runtime (>= 24.7) already provides it. It is
 * synchronous like better-sqlite3; this class puts an async, transaction-safe face on it (below).
 *
 * ONE connection, WAL mode. Repositories receive this object (never the raw handle); HTTP receives nothing.
 *
 * TRANSACTIONS (the design decision that matters):
 *   Repository methods are async, and a use case may `await` several of them. With a single connection that is only
 *   safe if nothing else can run a statement while a transaction is open — otherwise another request's write would land
 *   INSIDE our transaction and be committed/rolled back with it. So:
 *     - `transaction(fn)` takes an exclusive in-process lock, `BEGIN IMMEDIATE`, runs `fn`, then COMMIT (or ROLLBACK on
 *       error) — the caller composes several repository calls inside `fn` (application → UnitOfWork → repositories);
 *     - statements issued from inside `fn` are recognised through `AsyncLocalStorage` and run directly;
 *     - every other statement waits until no transaction is open.
 *   Nested `transaction()` calls join the outer one (there is no partial rollback). Keep transactions short: no network
 *   or password hashing inside — they stall every other database operation while open.
 *
 * ERRORS: SQLite errors never reach a caller raw. BUSY/LOCKED (another process holds the file) become
 * `AppError('service_unavailable')` (retryable); everything else becomes a generic `DatabaseError` whose `cause` keeps the
 * driver detail for the server log only (`defineUseCase` maps it to `internal_error`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, StatementSync } from 'node:sqlite';
import { AppError } from '../../application/index.ts';

/** Bound parameter values (SQLite storage classes). */
export type SqlValue = SQLInputValue;
export type SqlRow = Record<string, unknown>;

/** `PRAGMA application_id`: 'KAYD'. Refuses to adopt a foreign SQLite file as ours. */
export const APPLICATION_ID = 0x4b415944;

export const DATABASE_DEFAULTS = {
  busyTimeoutMs: 5000,
  /** Bound the WAL file after checkpoints. */
  journalSizeLimitBytes: 64 * 1024 * 1024,
} as const;

export class DatabaseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseError';
  }
}

interface SqliteErrorLike {
  code?: string;
  errcode?: number;
}
const errcodeOf = (error: unknown): number | undefined => (error as SqliteErrorLike | null)?.errcode;

/** Constraint kinds a repository may want to handle itself (uniqueness of a key it owns). */
export const isUniqueViolation = (error: unknown): boolean => {
  const code = errcodeOf(error instanceof DatabaseError ? error.cause : error);
  return code === 2067 /* UNIQUE */ || code === 1555 /* PRIMARYKEY */;
};
export const isForeignKeyViolation = (error: unknown): boolean => errcodeOf(error instanceof DatabaseError ? error.cause : error) === 787;

function mapError(error: unknown): Error {
  if (error instanceof AppError || error instanceof DatabaseError) return error;
  const primary = (errcodeOf(error) ?? 0) & 0xff;
  if (primary === 5 /* BUSY */ || primary === 6 /* LOCKED */) {
    return new AppError('service_unavailable', { retryAfterSeconds: 1, operation: 'database.contention', cause: error });
  }
  return new DatabaseError('database operation failed', { cause: error });
}

export interface OpenOptions {
  /** File path, or `:memory:` (never in production). */
  readonly path: string;
  readonly busyTimeoutMs?: number;
}

export class SqliteDatabase {
  private readonly statements = new Map<string, StatementSync>();
  private readonly context = new AsyncLocalStorage<true>();
  private active: Promise<void> | null = null;
  private closed = false;

  private constructor(
    private readonly handle: DatabaseSync,
    readonly path: string,
  ) {}

  /** Opens the database, applies and VERIFIES the PRAGMAs, and checks it is a Kaydet database. Throws on any doubt. */
  static open(options: OpenOptions): SqliteDatabase {
    const memory = options.path === ':memory:';
    const busyTimeoutMs = options.busyTimeoutMs ?? DATABASE_DEFAULTS.busyTimeoutMs;
    let handle: DatabaseSync;
    try {
      handle = new DatabaseSync(options.path, { timeout: busyTimeoutMs, enableForeignKeyConstraints: true });
    } catch (error) {
      throw new DatabaseError('cannot open the database file', { cause: error });
    }
    const db = new SqliteDatabase(handle, options.path);
    try {
      // Order matters: the busy timeout first, so the journal-mode switch itself can wait for a lock.
      handle.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
      handle.exec('PRAGMA foreign_keys = ON');
      handle.exec('PRAGMA trusted_schema = OFF');
      // Identity BEFORE anything that writes to the file: switching the journal mode changes the file header, and a
      // SQLite file that is not ours must be left exactly as we found it.
      db.claimOrVerifyIdentity();
      if (!memory) {
        handle.exec('PRAGMA journal_mode = WAL');
        // FULL: users, sessions and encrypted credentials are authoritative data, not a rebuildable cache — a commit must
        // survive a power loss. (WAL + NORMAL would risk the last commits.) The cost is one fsync per commit.
        handle.exec('PRAGMA synchronous = FULL');
        handle.exec(`PRAGMA journal_size_limit = ${DATABASE_DEFAULTS.journalSizeLimitBytes}`);
      }
      db.verifyPragmas(memory, busyTimeoutMs);
      return db;
    } catch (error) {
      try {
        handle.close();
      } catch {
        // already closed
      }
      throw error instanceof DatabaseError ? error : new DatabaseError('database configuration failed', { cause: error });
    }
  }

  /** Reads the settings BACK: a PRAGMA that silently did not take effect is a startup failure, not a hope. */
  private verifyPragmas(memory: boolean, busyTimeoutMs: number): void {
    const read = (name: string): unknown => Object.values(this.handle.prepare(`PRAGMA ${name}`).get() ?? {})[0];
    const expect = (name: string, actual: unknown, wanted: unknown) => {
      if (actual !== wanted) throw new DatabaseError(`PRAGMA ${name} is ${String(actual)}, expected ${String(wanted)}`);
    };
    expect('foreign_keys', read('foreign_keys'), 1);
    expect('busy_timeout', read('busy_timeout'), Math.trunc(busyTimeoutMs));
    expect('trusted_schema', read('trusted_schema'), 0);
    if (!memory) {
      expect('journal_mode', String(read('journal_mode')).toLowerCase(), 'wal');
      expect('synchronous', read('synchronous'), 2);
    }
  }

  private claimOrVerifyIdentity(): void {
    const id = Number(Object.values(this.handle.prepare('PRAGMA application_id').get() ?? {})[0]);
    const objects = Number(this.handle.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()?.['n']);
    if (id === APPLICATION_ID) return;
    if (id === 0 && objects === 0) {
      this.handle.exec(`PRAGMA application_id = ${APPLICATION_ID}`); // a fresh, empty file becomes ours
      return;
    }
    throw new DatabaseError('this SQLite file is not a Kaydet database (refusing to use or modify it)');
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.handle.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** Resolves when no OTHER transaction is open (statements inside our own transaction never wait). */
  private async gate(): Promise<void> {
    while (this.active !== null && this.context.getStore() === undefined) await this.active;
    if (this.closed) throw new DatabaseError('database is closed');
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> {
    await this.gate();
    try {
      return { changes: Number(this.prepare(sql).run(...params).changes) };
    } catch (error) {
      throw mapError(error);
    }
  }

  async get<T extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T | undefined> {
    await this.gate();
    try {
      return this.prepare(sql).get(...params) as T | undefined;
    } catch (error) {
      throw mapError(error);
    }
  }

  async all<T extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    await this.gate();
    try {
      return this.prepare(sql).all(...params) as T[];
    } catch (error) {
      throw mapError(error);
    }
  }

  /** Several statements, no parameters (migrations). */
  async exec(sql: string): Promise<void> {
    await this.gate();
    try {
      this.handle.exec(sql);
    } catch (error) {
      throw mapError(error);
    }
  }

  /**
   * Runs `fn` atomically: everything its repository calls write commits together or not at all. Exclusive; other
   * statements wait. A nested call joins the outer transaction.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.context.getStore() !== undefined) return fn();
    while (this.active !== null) await this.active;
    if (this.closed) throw new DatabaseError('database is closed');

    let release!: () => void;
    this.active = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      try {
        this.handle.exec('BEGIN IMMEDIATE');
      } catch (error) {
        throw mapError(error);
      }
      try {
        const result = await this.context.run(true, fn);
        this.handle.exec('COMMIT');
        return result;
      } catch (error) {
        if (this.handle.isTransaction) this.handle.exec('ROLLBACK');
        throw error;
      }
    } finally {
      this.active = null;
      release();
    }
  }

  /** Is a transaction open right now? (tests) */
  get inTransaction(): boolean {
    return this.handle.isTransaction;
  }

  /** Waits for an open transaction, then closes (the last connection checkpoints the WAL into the main file). */
  async close(): Promise<void> {
    if (this.closed) return;
    while (this.active !== null) await this.active;
    this.closed = true;
    this.statements.clear();
    try {
      this.handle.close();
    } catch (error) {
      throw mapError(error);
    }
  }

  get isOpen(): boolean {
    return !this.closed && this.handle.isOpen;
  }
}

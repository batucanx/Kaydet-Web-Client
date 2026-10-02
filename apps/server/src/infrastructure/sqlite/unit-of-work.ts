import type { UnitOfWork } from '../../application/ports/transaction/unit-of-work.ts';
import type { SqliteDatabase } from './database.ts';

/** Genuine atomicity: `run` is one SQLite transaction (BEGIN IMMEDIATE … COMMIT, ROLLBACK on error). */
export class SqliteUnitOfWork implements UnitOfWork {
  constructor(private readonly db: SqliteDatabase) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }
}

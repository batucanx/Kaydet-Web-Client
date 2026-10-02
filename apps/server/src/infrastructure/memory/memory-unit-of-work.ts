import type { UnitOfWork } from '../../application/ports/transaction/unit-of-work.ts';

/**
 * In-memory "transactions": runs the function, nothing more. There is no rollback — this adapter is a test double for
 * application logic; atomicity is proven against the SQLite adapter.
 */
export class MemoryUnitOfWork implements UnitOfWork {
  run<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

/**
 * Atomic multi-step changes.
 *
 *     use case ──▶ transactions.run(async () => { repoA.save(...); repoB.save(...); })  ──▶ commit, or roll back everything
 *
 * The transaction boundary belongs to the USE CASE (which knows which steps must succeed together); repositories do not
 * open their own transactions, so any number of them can take part in one. Inside `run`, repository calls made through
 * the normal ports are automatically part of the transaction (the adapter tracks it; no handle is passed around).
 *
 * Rules for callers:
 *  - keep it short: no network calls, no password hashing, no waiting on the user inside `run`;
 *  - publish events AFTER `run` resolves (never announce a change that may still roll back);
 *  - a nested `run` joins the outer transaction (there is no partial rollback).
 *
 * The in-memory adapter runs `fn` without atomicity (it is a test double); the SQLite adapter is genuinely atomic.
 */
export interface UnitOfWork {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

import type { Clock } from '../../application/index.ts';
import type { LoginAttempt, LoginRateLimiter, ThrottleDecision } from '../../application/ports/security/index.ts';
import type { SecurityPolicy } from '../../config/index.ts';

interface Entry {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
}

/**
 * In-memory login throttling — DEVELOPMENT / SINGLE-INSTANCE protection only.
 *
 * Limits: state is per process (several instances each keep their own counters, restarts forget them) and bounded
 * (`maxEntries`; when full the oldest entries are dropped, so an attacker who floods the table with junk keys can shed
 * old counters). A distributed limiter (shared store) implements the same `LoginRateLimiter` port.
 *
 * Behaviour, per key (normalised identifier and client address separately): failures up to the threshold are free; from
 * the threshold on, each further failure locks the key for `base * 2^(failures - threshold)` seconds (capped). A locked
 * key rejects attempts without verifying them and without counting them. Failures are forgotten after `windowSeconds`
 * without a new one. A success clears the identifier's counter (never the address's).
 */
export class MemoryLoginRateLimiter implements LoginRateLimiter {
  private readonly byIdentifier = new Map<string, Entry>();
  private readonly byAddress = new Map<string, Entry>();

  constructor(
    private readonly clock: Clock,
    private readonly limits: SecurityPolicy['loginLimits'],
    private readonly maxEntries = 10_000,
  ) {}

  private live(table: Map<string, Entry>, key: string, now: number): Entry | undefined {
    const entry = table.get(key);
    if (entry !== undefined && now - entry.lastFailureAt > this.limits.windowSeconds * 1000) {
      table.delete(key);
      return undefined;
    }
    return entry;
  }

  check(attempt: LoginAttempt): Promise<ThrottleDecision> {
    const now = this.clock.now().getTime();
    const lockedUntil = Math.max(
      this.live(this.byIdentifier, attempt.identifier, now)?.lockedUntil ?? 0,
      this.live(this.byAddress, attempt.address, now)?.lockedUntil ?? 0,
    );
    if (lockedUntil > now) return Promise.resolve({ allowed: false, retryAfterSeconds: Math.ceil((lockedUntil - now) / 1000) });
    return Promise.resolve({ allowed: true });
  }

  recordFailure(attempt: LoginAttempt): Promise<void> {
    const now = this.clock.now().getTime();
    this.fail(this.byIdentifier, attempt.identifier, this.limits.maxFailuresPerIdentifier, now);
    this.fail(this.byAddress, attempt.address, this.limits.maxFailuresPerAddress, now);
    return Promise.resolve();
  }

  recordSuccess(attempt: LoginAttempt): Promise<void> {
    this.byIdentifier.delete(attempt.identifier);
    return Promise.resolve();
  }

  private fail(table: Map<string, Entry>, key: string, threshold: number, now: number): void {
    const failures = (this.live(table, key, now)?.failures ?? 0) + 1;
    let lockedUntil = 0;
    if (failures >= threshold) {
      const seconds = Math.min(this.limits.backoffBaseSeconds * 2 ** (failures - threshold), this.limits.backoffMaxSeconds);
      lockedUntil = now + seconds * 1000;
    }
    table.delete(key); // re-insert: keeps recently active keys at the young end
    table.set(key, { failures, lastFailureAt: now, lockedUntil });
    if (table.size > this.maxEntries) {
      const oldest = table.keys().next();
      if (!oldest.done) table.delete(oldest.value);
    }
  }
}

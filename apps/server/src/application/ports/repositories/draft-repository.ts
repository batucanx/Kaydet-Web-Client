import type { DraftDTO, OutboxDTO } from '@kaydet/domain';

/** Drafts are namespaced per user: the same client-generated draft id of two users never collides. */
export interface DraftRepository {
  find(userId: string, draftId: string): Promise<DraftDTO | null>;
  save(userId: string, draft: DraftDTO): Promise<void>;
  /** Removes the draft and its attachment records. */
  remove(userId: string, draftId: string): Promise<void>;
}

/** Send operations (decision D8: their own id, distinct from draft and message). */
export interface OutboxRepository {
  find(userId: string, outboxId: string): Promise<OutboxDTO | null>;
  /** Latest operation created from this draft. */
  findByDraft(userId: string, draftId: string): Promise<OutboxDTO | null>;
  save(userId: string, outbox: OutboxDTO): Promise<void>;
  remove(userId: string, outboxId: string): Promise<void>;
  /**
   * Retry bookkeeping of a send (INTERNAL: not part of the contract DTO). The durable worker (a later phase) owns when
   * these change; storage only keeps them. Transitions of `state` itself belong to the application, see DATABASE.md.
   */
  retryState(userId: string, outboxId: string): Promise<OutboxRetryState | null>;
  setRetryState(userId: string, outboxId: string, state: OutboxRetryState): Promise<void>;

  /**
   * Atomically claims the next send operation that is ready to process.
   */
  claimNextDue(workerToken: string, leaseDurationMs: number, now: Date): Promise<ClaimedOutboxItem | null>;

  /** Marks the send operation as successfully completed and links the resulting sent message id. */
  completeSend(userId: string, outboxId: string, messageId: string | null, now: Date): Promise<void>;

  /**
   * Records a failure attempt. If retryDelayMs is provided, schedules nextAttemptAt.
   * If retryDelayMs is null, marks as permanently failed without further attempts.
   */
  failAttempt(userId: string, outboxId: string, error: string, retryDelayMs: number | null, now: Date): Promise<void>;

  /**
   * Recovers operations stuck in 'sending' whose leases expired, returning them to 'queued' or retryable 'failed'.
   */
  recoverStaleLeases(now: Date): Promise<number>;
}

export interface ClaimedOutboxItem {
  readonly outboxId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly draftId: string;
  readonly attemptCount: number;
}

export interface OutboxRetryState {
  readonly attemptCount: number;
  readonly nextAttemptAt: Date | null;
}

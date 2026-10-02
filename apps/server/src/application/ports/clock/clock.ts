/** Time source for everything time-dependent (session expiry, undo windows, draft/outbox timestamps). */
export interface Clock {
  now(): Date;
}

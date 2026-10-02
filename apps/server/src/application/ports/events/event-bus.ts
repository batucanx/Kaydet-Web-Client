/**
 * Application event bus. Use cases publish; a later phase subscribes the SSE stream (`GET /events`) to it.
 *
 * The event payloads ARE the Phase 2 contract (`MailEvent`): invalidation hints without message content,
 * so what a use case publishes is exactly what a browser could later receive. Events are addressed to a user
 * — the SSE subscriber of session X must only ever see the events of X's user.
 *
 * Mapping of the conceptual events to the contract: MessageChanged → `messages.changed`, FolderChanged →
 * `folders.changed`, AccountSyncChanged → `sync.status` / `accounts.changed`, OutboxChanged → `outbox.changed`.
 * (A draft change is not an event: drafts are the client's own autosave.)
 */
import type { MailEvent } from '@kaydet/domain';

export interface AddressedEvent {
  readonly userId: string;
  readonly event: MailEvent;
}

export type EventListener = (event: AddressedEvent) => void;
export type Unsubscribe = () => void;

export interface EventBus {
  /** Fire-and-forget: a failing subscriber must not fail the use case that published. */
  publish(userId: string, event: MailEvent): void;
  subscribe(listener: EventListener): Unsubscribe;
  /** Drops all subscribers. */
  close(): Promise<void>;
}

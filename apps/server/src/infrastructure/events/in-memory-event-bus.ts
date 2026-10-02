import type { AddressedEvent, EventBus, EventListener, Unsubscribe } from '../../application/index.ts';
import type { MailEvent } from '@kaydet/domain';

/** Process-local synchronous fan-out. Enough for one server process; a multi-process deployment swaps this adapter. */
export class InMemoryEventBus implements EventBus {
  private readonly listeners = new Set<EventListener>();
  private closed = false;

  publish(userId: string, event: MailEvent): void {
    if (this.closed) return;
    const addressed: AddressedEvent = { userId, event };
    for (const listener of [...this.listeners]) {
      try {
        listener(addressed);
      } catch {
        // A failing subscriber must not fail the use case that published.
      }
    }
  }

  subscribe(listener: EventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    return Promise.resolve();
  }
}

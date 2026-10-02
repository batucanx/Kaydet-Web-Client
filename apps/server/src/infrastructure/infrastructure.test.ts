import { describe, expect, it } from 'vitest';
import { InMemoryEventBus } from './events/in-memory-event-bus.ts';
import { UnavailableMailbox } from './mail/unavailable-mailbox.ts';
import { MemoryBlobStorage } from './memory/index.ts';

describe('InMemoryEventBus', () => {
  it('delivers addressed events to subscribers, supports unsubscribe, isolates failing listeners and stops on close', async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    const off = bus.subscribe(({ userId, event }) => seen.push(`${userId}:${event.type}`));
    bus.publish('u1', { type: 'accounts.changed' });
    off();
    bus.publish('u1', { type: 'session.ended' });
    expect(seen).toEqual(['u1:accounts.changed']);
    await bus.close();
    bus.subscribe(() => seen.push('after close'));
    bus.publish('u1', { type: 'accounts.changed' });
    expect(seen).toEqual(['u1:accounts.changed']);
  });
});

describe('MemoryBlobStorage', () => {
  const stream = (...chunks: number[][]) =>
    (async function* () {
      for (const chunk of chunks) yield Uint8Array.from(chunk);
    })();

  it('stores and reads back bytes', async () => {
    const blobs = new MemoryBlobStorage();
    expect(await blobs.put('k', stream([1, 2], [3]), { maxBytes: 10 })).toEqual({ sizeBytes: 3 });
    const blob = await blobs.open('k');
    expect(blob?.sizeBytes).toBe(3);
    const read: number[] = [];
    for await (const chunk of blob!.stream) read.push(...chunk);
    expect(read).toEqual([1, 2, 3]);
    await blobs.remove('k');
    expect(await blobs.open('k')).toBeNull();
  });

  it('stops reading as soon as the limit is exceeded (attachment_too_large) and stores nothing', async () => {
    const blobs = new MemoryBlobStorage();
    let pulled = 0;
    const endless = (async function* () {
      for (;;) {
        pulled += 1;
        yield new Uint8Array(4);
      }
    })();
    await expect(blobs.put('k', endless, { maxBytes: 10 })).rejects.toMatchObject({ code: 'attachment_too_large' });
    expect(pulled).toBe(3);
    expect(await blobs.open('k')).toBeNull();
  });
});

describe('unavailable mailbox (until the IMAP phase)', () => {
  it('refuses provider work with service_unavailable and holds no undo state', async () => {
    const mailbox = new UnavailableMailbox();
    await expect(mailbox.requestSync()).rejects.toMatchObject({ code: 'service_unavailable' });
    await expect(mailbox.applyActions()).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await mailbox.undo()).toEqual({ restored: false });
  });
});

/**
 * The durable mail store: messages and everything hanging off them, provider identity separation, pagination, the search
 * index, and transactions over batches. Everything runs through the real repositories on a real database file.
 */
import { applyMessageFilter, EMPTY_MESSAGE_FILTER, EMPTY_SEARCH_FILTERS } from '@kaydet/domain';
import type { MessageDTO, MessageFilter, MessageListParams, MessageSort } from '@kaydet/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, ANONYMOUS_ACTOR, NO_SESSION } from '../../application/index.ts';
import type { RequestContext } from '../../application/index.ts';
import { IDS, USER_A, USER_B, message } from '../../testing/fixtures.ts';
import { createSqliteTestApplication } from '../../testing/sqlite.ts';
import type { SqliteTestApplication } from '../../testing/sqlite.ts';

const apps: SqliteTestApplication[] = [];
const create = async () => {
  const app = await createSqliteTestApplication();
  apps.push(app);
  return app;
};
afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.cleanup();
});

const ctx = (userId: string): RequestContext => ({
  requestId: 'req',
  actor: userId === '' ? ANONYMOUS_ACTOR : { kind: 'user', userId },
  session: userId === '' ? NO_SESSION : { status: 'active', id: 's', expiresAt: new Date('2027-01-01T00:00:00.000Z'), csrfToken: 'c' },
  metadata: { method: 'TEST', route: '/test', clientAddress: '203.0.113.1' },
});
const A = ctx(USER_A);

const failure = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected a failure');
};

const a1 = (app: SqliteTestApplication) => app.access(IDS.a1, USER_A);
const store = (app: SqliteTestApplication, m: MessageDTO, extra: { provider?: Parameters<SqliteTestApplication['persistence']['mailStore']['upsertMessage']>[1]['provider'] } = {}) =>
  app.persistence.mailStore.upsertMessage(a1(app), { message: m, provider: extra.provider ?? null });

const params = (over: { folderId?: string; filter?: Partial<MessageFilter>; cursor?: string | null; limit?: number; pinned?: boolean } = {}): MessageListParams => ({
  scope: over.pinned === true ? { kind: 'pinned' } : { kind: 'folder', folderId: over.folderId ?? IDS.a1Custom },
  filter: { ...EMPTY_MESSAGE_FILTER, ...over.filter },
  cursor: over.cursor ?? null,
  limit: over.limit ?? 5,
});

/** Walks every page of a list through the USE CASE (cursors are opaque and query-bound, as the browser sees them). */
async function walk(app: SqliteTestApplication, over: Parameters<typeof params>[0]): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 200; guard++) {
    const page = await app.useCases.listMessages(A, IDS.a1, params({ ...over, cursor }));
    ids.push(...page.items.map((m) => m.id));
    cursor = page.nextCursor;
    if (cursor === null) return ids;
  }
  throw new Error('pagination did not terminate');
}

describe('a message round-trips through the database', () => {
  const full = (): MessageDTO =>
    message({
      id: 'm-full',
      accountId: IDS.a1,
      folderId: IDS.a1Custom,
      threadId: 'thread-42',
      from: { email: 'Şahan@example.com', name: 'Şahan Öztürk' },
      to: [{ email: 'z@example.com', name: 'Z' }, { email: 'a@example.com', name: '' }, { email: 'm@example.com', name: 'M' }],
      cc: [{ email: 'cc1@example.com', name: '' }, { email: 'cc2@example.com', name: 'İki' }],
      bcc: [{ email: 'bcc@example.com', name: '' }],
      subject: 'Toplantı özeti – ÇĞİÖŞÜ',
      preview: 'Kısa önizleme',
      date: '2026-09-15T08:30:15.123Z',
      seen: true,
      pinned: true,
      answered: true,
      forwarded: true,
      hasAttachments: true,
      body: { text: 'Düz metin gövde', html: { content: '<p>Sanitized</p>', sanitized: true } },
      attachments: [
        { id: 'full-att-1', messageId: 'm-full', fileName: 'rapor.pdf', mimeType: 'application/pdf', sizeBytes: 1234, isInline: false },
        { id: 'full-att-2', messageId: 'm-full', fileName: 'logo.png', mimeType: 'image/png', sizeBytes: 55, isInline: true },
      ],
    });

  it('every field, recipient order (to/cc/bcc), sanitized body and attachment metadata come back exactly', async () => {
    const app = await create();
    await store(app, full());
    expect(await app.persistence.messages.findOwned(USER_A, 'm-full')).toEqual(full());
  });

  it('a summary (list row) carries the "to" recipients in order and no body, cc, bcc or attachments', async () => {
    const app = await create();
    await store(app, full());
    const page = await app.useCases.listMessages(A, IDS.a1, params());
    const row = page.items.find((m) => m.id === 'm-full');
    expect(row?.to.map((a) => a.email)).toEqual(['z@example.com', 'a@example.com', 'm@example.com']);
    expect(Object.keys(row ?? {})).not.toEqual(expect.arrayContaining(['body']));
    for (const key of ['cc', 'bcc', 'body', 'attachments']) expect(row).not.toHaveProperty(key);
  });

  it('an update replaces recipients, body, labels and attachments as sets, and keeps one row', async () => {
    const app = await create();
    await store(app, full());
    await store(app, { ...full(), seen: false, pinned: false, subject: 'Değişti', to: [{ email: 'only@example.com', name: '' }], cc: [], bcc: [], body: { text: null, html: null }, attachments: [], hasAttachments: false });
    const after = await app.persistence.messages.findOwned(USER_A, 'm-full');
    expect(after).toMatchObject({ seen: false, pinned: false, subject: 'Değişti', cc: [], bcc: [], body: { text: null, html: null }, attachments: [], hasAttachments: false });
    expect(after?.to).toEqual([{ email: 'only@example.com', name: '' }]);
    const { db } = app.persistence;
    expect((await db.get("SELECT count(*) AS n FROM messages WHERE id = 'm-full'"))?.['n']).toBe(1);
    expect((await db.get("SELECT count(*) AS n FROM message_recipients WHERE message_id = 'm-full'"))?.['n']).toBe(1);
    expect((await db.get("SELECT count(*) AS n FROM message_bodies WHERE message_id = 'm-full'"))?.['n']).toBe(0);
    expect((await db.get("SELECT count(*) AS n FROM attachments WHERE message_id = 'm-full'"))?.['n']).toBe(0);
  });

  it('keeps the same row identity when updated (the search index row and created_at do not move)', async () => {
    const app = await create();
    await store(app, full());
    const before = await app.persistence.db.get("SELECT rowid AS r, created_at FROM messages WHERE id = 'm-full'");
    app.clock.advance(60_000);
    await store(app, { ...full(), subject: 'Güncel' });
    const after = await app.persistence.db.get("SELECT rowid AS r, created_at, updated_at FROM messages WHERE id = 'm-full'");
    expect(after?.['r']).toBe(before?.['r']);
    expect(after?.['created_at']).toBe(before?.['created_at']);
    expect(String(after?.['updated_at']) > String(before?.['created_at'])).toBe(true);
  });

  it('normalises dates to ISO UTC: an offset input is stored and returned as the same instant in Z form', async () => {
    const app = await create();
    await store(app, { ...full(), id: 'm-offset', attachments: [], hasAttachments: false, date: '2026-09-15T11:30:15.123+03:00' });
    expect((await app.persistence.messages.findOwned(USER_A, 'm-offset'))?.date).toBe('2026-09-15T08:30:15.123Z');
    expect((await app.persistence.db.get("SELECT date_utc FROM messages WHERE id = 'm-offset'"))?.['date_utc']).toBe('2026-09-15T08:30:15.123Z');
  });

  it('an invalid date is refused (nothing is written)', async () => {
    const app = await create();
    await expect(store(app, { ...full(), id: 'm-bad', date: 'not a date' })).rejects.toThrow();
    expect(await app.persistence.messages.findOwned(USER_A, 'm-bad')).toBeNull();
  });

  it('drafts: draftId is kept on the summary, and draft-only invariants hold', async () => {
    const app = await create();
    const draft = await app.persistence.messages.findOwned(USER_A, IDS.mDraft);
    expect(draft).toMatchObject({ draft: true, draftId: 'draft-existing' });
    await expect(store(app, { ...full(), id: 'm-notdraft', draftId: 'd1' })).rejects.toThrow(); // CHECK: draftId only on a draft
  });

  it('outbox state and its safe error text ride on the message row', async () => {
    const app = await create();
    await store(app, { ...full(), id: 'm-out', attachments: [], hasAttachments: false, outbox: { state: 'failed', error: 'İleti gönderilemedi.' } });
    expect((await app.persistence.messages.findOwned(USER_A, 'm-out'))?.outbox).toEqual({ state: 'failed', error: 'İleti gönderilemedi.' });
  });
});

describe('ownership and isolation', () => {
  it('another user cannot read or locate a message; a message id cannot be written into a foreign account', async () => {
    const app = await create();
    expect(await app.persistence.messages.findOwned(USER_B, IDS.m1)).toBeNull();
    expect((await app.persistence.messages.locateOwned(USER_B, [IDS.m1, IDS.mB1])).has(IDS.m1)).toBe(false);
    expect((await app.persistence.messages.locateOwned(USER_B, [IDS.m1, IDS.mB1])).has(IDS.mB1)).toBe(true);

    const hijack = message({ id: IDS.m1, accountId: IDS.b1, folderId: IDS.b1Inbox, subject: 'ele geçirildi' });
    await expect(app.persistence.mailStore.upsertMessage(app.access(IDS.b1, USER_B), { message: hijack, provider: null })).rejects.toThrow(/another account/);
    expect((await app.persistence.messages.findOwned(USER_A, IDS.m1))?.subject).toBe('Toplantı notları');
    // …nor into a folder of another account:
    await expect(store(app, message({ id: 'm-x', accountId: IDS.a1, folderId: IDS.b1Inbox }))).rejects.toThrow(/folder does not belong/);
  });

  it('lists are scoped to the account, and a folder of another account is empty, not an error leak', async () => {
    const app = await create();
    const page = await app.persistence.messages.listPage(a1(app), { scope: { kind: 'folder', folderId: IDS.b1Inbox }, filter: EMPTY_MESSAGE_FILTER, page: { position: null, limit: 10 } });
    expect(page.items).toEqual([]);
  });

  it('messages flagged \\Deleted by the server are stored but invisible to lists, reads, actions and search', async () => {
    const app = await create();
    await app.persistence.mailStore.upsertMessage(a1(app), { message: message({ id: 'm-gone', accountId: IDS.a1, folderId: IDS.a1Custom, subject: 'Kaybolan' }), provider: null, serverDeleted: true });
    expect(await app.persistence.messages.findOwned(USER_A, 'm-gone')).toBeNull();
    expect((await app.persistence.messages.locateOwned(USER_A, ['m-gone'])).size).toBe(0);
    expect(await walk(app, { folderId: IDS.a1Custom })).not.toContain('m-gone');
    expect((await app.useCases.search(A, searchParams('kaybolan'))).items).toEqual([]);
    expect((await app.persistence.db.get("SELECT count(*) AS n FROM messages WHERE id = 'm-gone'"))?.['n']).toBe(1); // still stored
    const folder = await app.persistence.folders.find(a1(app), IDS.a1Custom);
    expect(folder?.totalCount).toBe(0); // and not counted
  });
});

describe('read / unread, pinned, thread, labels', () => {
  it('unread and pinned flags drive the filters, the pinned view and the folder counters', async () => {
    const app = await create();
    const base = { accountId: IDS.a1, folderId: IDS.a1Custom };
    await store(app, message({ ...base, id: 'u1', date: '2026-09-10T10:00:00.000Z', seen: false }));
    await store(app, message({ ...base, id: 'u2', date: '2026-09-11T10:00:00.000Z', seen: true, pinned: true }));
    await store(app, message({ ...base, id: 'u3', date: '2026-09-12T10:00:00.000Z', seen: false, pinned: true }));
    expect(await walk(app, { folderId: IDS.a1Custom, filter: { unread: true } })).toEqual(['u3', 'u1']);
    expect(await walk(app, { folderId: IDS.a1Custom, filter: { pinned: true } })).toEqual(['u3', 'u2']);
    expect(await walk(app, { pinned: true })).toEqual(['u3', 'u2']);
    expect(await app.persistence.folders.find(a1(app), IDS.a1Custom)).toMatchObject({ totalCount: 3, unreadCount: 2 });

    await store(app, message({ ...base, id: 'u1', date: '2026-09-10T10:00:00.000Z', seen: true })); // marked read
    expect(await walk(app, { folderId: IDS.a1Custom, filter: { unread: true } })).toEqual(['u3']);
    expect(await app.persistence.folders.find(a1(app), IDS.a1Custom)).toMatchObject({ unreadCount: 1 });
  });

  it('the pinned view spans folders of the account but never other accounts', async () => {
    const app = await create();
    await store(app, message({ accountId: IDS.a1, folderId: IDS.a1Trash, id: 'p-trash', pinned: true }));
    await app.persistence.mailStore.upsertMessage(app.access(IDS.a2, USER_A), { message: message({ accountId: IDS.a2, folderId: IDS.a2Inbox, id: 'p-a2', pinned: true }), provider: null });
    const ids = await walk(app, { pinned: true });
    expect(ids).toContain('p-trash');
    expect(ids).not.toContain('p-a2');
  });

  it('threadId is data: it is stored as given, shared by a conversation, and indexed', async () => {
    const app = await create();
    await store(app, message({ accountId: IDS.a1, folderId: IDS.a1Custom, id: 't-1', threadId: 'conv-1', date: '2026-09-10T10:00:00.000Z' }));
    await store(app, message({ accountId: IDS.a1, folderId: IDS.a1Trash, id: 't-2', threadId: 'conv-1', date: '2026-09-11T10:00:00.000Z' }));
    const rows = await app.persistence.db.all("SELECT id FROM messages WHERE account_id = ? AND thread_id = 'conv-1' ORDER BY date_utc", [IDS.a1]);
    expect(rows.map((r) => r['id'])).toEqual(['t-1', 't-2']);
    expect((await app.persistence.messages.findOwned(USER_A, 't-2'))?.threadId).toBe('conv-1');
  });

  it('labels: applied by name, filterable, ordered, and gone when the label is deleted', async () => {
    const app = await create();
    const work = await app.useCases.createLabel(A, IDS.a1, { name: 'İş', tone: 1 });
    await app.useCases.createLabel(A, IDS.a1, { name: 'Acil', tone: 2 });
    const base = { accountId: IDS.a1, folderId: IDS.a1Custom };
    await store(app, message({ ...base, id: 'l1', date: '2026-09-10T10:00:00.000Z', labels: ['İş', 'Acil'] }));
    await store(app, message({ ...base, id: 'l2', date: '2026-09-11T10:00:00.000Z', labels: ['Acil'] }));
    await store(app, message({ ...base, id: 'l3', date: '2026-09-12T10:00:00.000Z' }));
    expect(await walk(app, { folderId: IDS.a1Custom, filter: { label: 'Acil' } })).toEqual(['l2', 'l1']);
    expect(await walk(app, { folderId: IDS.a1Custom, filter: { label: 'İş' } })).toEqual(['l1']);
    expect((await app.persistence.messages.findOwned(USER_A, 'l1'))?.labels).toEqual(['Acil', 'İş']); // stable, by folded name
    await app.useCases.deleteLabel(A, IDS.a1, work.id);
    expect((await app.persistence.messages.findOwned(USER_A, 'l1'))?.labels).toEqual(['Acil']);
  });
});

describe('cursor pagination (keyset, opaque, contract-compatible)', () => {
  /** Distinct senders/subjects with Turkish letters, so every sort key is unique and comparable with the domain's order. */
  const seedMany = async (app: SqliteTestApplication) => {
    const subjects = ['çilek', 'Çay', 'ağaç', 'Zeytin', 'ırmak', 'iğne', 'Işık', 'öğle', 'Şeker', 'ütü', 'Elma', 'armut', 'Muz', 'kiraz', 'Üzüm', 'incir', 'Nar', 'kavun', 'Karpuz', 'dut', 'Erik', 'Hurma', 'Vişne', 'Portakal', 'Limon'];
    await app.persistence.transactions.run(async () => {
      for (const [i, subject] of subjects.entries()) {
        await store(
          app,
          message({
            id: `pg-${String(i).padStart(2, '0')}`,
            accountId: IDS.a1,
            folderId: IDS.a1Custom,
            subject,
            from: { email: `sender${i}@example.com`, name: `${subjects[(i * 7) % subjects.length]} Kişisi` },
            date: new Date(Date.parse('2026-08-01T00:00:00.000Z') + i * 3_600_000).toISOString(),
            seen: i % 3 === 0,
            pinned: i % 5 === 0,
            hasAttachments: i % 4 === 0,
          }),
        );
      }
    });
    return (await app.persistence.messages.listPage(a1(app), { scope: { kind: 'folder', folderId: IDS.a1Custom }, filter: EMPTY_MESSAGE_FILTER, page: { position: null, limit: 100 } })).items;
  };

  it('every sort order and filter walks the same sequence the domain rules produce (parity with the mobile rules)', async () => {
    const app = await create();
    const all = await seedMany(app);
    for (const sort of ['dateDesc', 'dateAsc', 'senderAZ', 'subjectAZ'] as MessageSort[]) {
      for (const filter of [{}, { unread: true }, { pinned: true }, { attachments: true }, { unread: true, attachments: true }] as Array<Partial<MessageFilter>>) {
        const full: MessageFilter = { ...EMPTY_MESSAGE_FILTER, ...filter, sort };
        const expected = applyMessageFilter(all, full).map((m) => m.id);
        expect(await walk(app, { folderId: IDS.a1Custom, filter: { ...filter, sort }, limit: 4 }), `${sort} ${JSON.stringify(filter)}`).toEqual(expected);
      }
    }
  });

  it('the last page has nextCursor null even when the total is an exact multiple of the page size', async () => {
    const app = await create();
    await seedMany(app);
    const first = await app.useCases.listMessages(A, IDS.a1, params({ limit: 25 }));
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).toBeNull();
    const pages: number[] = [];
    let cursor: string | null = null;
    do {
      const page = await app.useCases.listMessages(A, IDS.a1, params({ limit: 5, cursor }));
      pages.push(page.items.length);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(pages).toEqual([5, 5, 5, 5, 5]);
  });

  it('is STABLE while the list changes: new mail arriving mid-walk causes no duplicate and no skipped row (offsets would)', async () => {
    const app = await create();
    await seedMany(app);
    const first = await app.useCases.listMessages(A, IDS.a1, params({ limit: 10 }));
    // New mail arrives at the top, and one already-seen row is deleted, between two requests:
    await store(app, message({ id: 'newest', accountId: IDS.a1, folderId: IDS.a1Custom, date: '2027-01-01T00:00:00.000Z' }));
    await app.persistence.mailStore.removeMessage(a1(app), first.items[3]?.id as string);
    const second = await app.useCases.listMessages(A, IDS.a1, params({ limit: 10, cursor: first.nextCursor }));
    const restOfOriginal = (await walk(app, { limit: 100 })).filter((id) => id !== 'newest');
    const seen = [...first.items.map((m) => m.id), ...second.items.map((m) => m.id)];
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(second.items.map((m) => m.id)).toEqual(restOfOriginal.filter((id) => !first.items.some((m) => m.id === id)).slice(0, 10));
  });

  it('cursors are opaque, are not row offsets, and are bound to their query (opaque is not secret: an unsigned keyset)', async () => {
    const app = await create();
    await seedMany(app);
    const page = await app.useCases.listMessages(A, IDS.a1, params({ limit: 5 }));
    const cursor = page.nextCursor as string;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toMatch(/^\d+$/); // not an offset
    expect(cursor).not.toContain('pg-');
    expect((await failure(app.useCases.listMessages(A, IDS.a1, params({ limit: 5, cursor, filter: { unread: true } })))).code).toBe('invalid_cursor'); // other filter
    expect((await failure(app.useCases.listMessages(A, IDS.a1, params({ folderId: IDS.a1Inbox, limit: 5, cursor })))).code).toBe('invalid_cursor'); // other folder
  });

  it('a forged position that reaches the repository is rejected, never interpolated', async () => {
    const app = await create();
    for (const position of ['garbage', '[]', '["x"]', '[1,2]', '["2026-09-10T10:00:00.000Z",""]', '["not-a-date","id"]', `["${'x'.repeat(2000)}","id"]`, '["2026-09-10T10:00:00.000Z","id\'); DROP TABLE messages; --"]']) {
      const attempt = app.persistence.messages.listPage(a1(app), { scope: { kind: 'folder', folderId: IDS.a1Custom }, filter: EMPTY_MESSAGE_FILTER, page: { position, limit: 5 } });
      if (position.includes('DROP TABLE')) await expect(attempt).resolves.toBeDefined(); // a syntactically valid position is just data
      else expect((await failure(attempt)).code, position).toBe('invalid_cursor');
    }
    expect((await app.persistence.db.get("SELECT count(*) AS n FROM sqlite_master WHERE name = 'messages'"))?.['n']).toBe(1);
  });

  it('the sort key stored for A-Z lists is truncated, so any subject still fits in a cursor', async () => {
    const app = await create();
    for (const i of [1, 2, 3]) await store(app, message({ id: `long-${i}`, accountId: IDS.a1, folderId: IDS.a1Custom, subject: `${'ş'.repeat(1500)}${i}` }));
    const page = await app.useCases.listMessages(A, IDS.a1, params({ limit: 1, filter: { sort: 'subjectAZ' } }));
    expect((page.nextCursor ?? '').length).toBeLessThan(2048);
    expect(await walk(app, { filter: { sort: 'subjectAZ' }, limit: 1 })).toHaveLength(3);
  });
});

describe('provider identity stays inside', () => {
  const provider = { uid: 4321, uidValidity: 99, modSeq: 777, messageIdHeader: '<abc@mail.example>', inReplyTo: '<prev@mail.example>', references: '<root@mail.example> <prev@mail.example>' };

  it('is stored and retrievable through the internal port, and appears in NO API-facing result', async () => {
    const app = await create();
    await store(app, message({ id: 'm-prov', accountId: IDS.a1, folderId: IDS.a1Custom, subject: 'Sağlayıcı' }), { provider });
    expect(await app.persistence.mailStore.providerRefOfMessage(a1(app), 'm-prov')).toEqual(provider);

    const dto = await app.persistence.messages.findOwned(USER_A, 'm-prov');
    const listed = await app.useCases.listMessages(A, IDS.a1, params());
    const searched = await app.useCases.search(A, searchParams('sağlayıcı'));
    const everything = JSON.stringify([dto, listed, searched]);
    for (const secret of ['4321', 'uid', 'UID', 'modseq', 'ModSeq', 'abc@mail.example', 'prev@mail.example', 'validity', 'Validity']) {
      expect(everything, secret).not.toContain(secret);
    }
  });

  it('a server message is unique per (folder, uidvalidity, uid); local-only messages (no uid) never collide', async () => {
    const app = await create();
    await store(app, message({ id: 'p1', accountId: IDS.a1, folderId: IDS.a1Custom }), { provider });
    await expect(store(app, message({ id: 'p2', accountId: IDS.a1, folderId: IDS.a1Custom }), { provider })).rejects.toThrow(); // same uid
    await expect(store(app, message({ id: 'p3', accountId: IDS.a1, folderId: IDS.a1Custom }), { provider: { ...provider, uidValidity: 100 } })).resolves.toBeUndefined(); // new UIDVALIDITY epoch
    await store(app, message({ id: 'l1', accountId: IDS.a1, folderId: IDS.a1Custom }));
    await store(app, message({ id: 'l2', accountId: IDS.a1, folderId: IDS.a1Custom }));
    expect(await app.persistence.messages.findOwned(USER_A, 'p2')).toBeNull(); // the failed insert left nothing behind
  });

  it('the API id is independent of the provider identity: a message keeps its id when the provider moves it', async () => {
    const app = await create();
    await store(app, message({ id: 'mv', accountId: IDS.a1, folderId: IDS.a1Custom }), { provider });
    await store(app, message({ id: 'mv', accountId: IDS.a1, folderId: IDS.a1Trash }), { provider: { ...provider, uid: 1, uidValidity: 5 } });
    expect((await app.persistence.messages.findOwned(USER_A, 'mv'))?.folderId).toBe(IDS.a1Trash);
    expect(await app.persistence.mailStore.providerRefOfMessage(a1(app), 'mv')).toMatchObject({ uid: 1, uidValidity: 5 });
  });

  it('provider reads are account-scoped', async () => {
    const app = await create();
    await store(app, message({ id: 'm-prov', accountId: IDS.a1, folderId: IDS.a1Custom }), { provider });
    expect(await app.persistence.mailStore.providerRefOfMessage(app.access(IDS.b1, USER_B), 'm-prov')).toBeNull();
  });
});

describe('attachment metadata', () => {
  const withAttachments = (id: string, ids: string[]): MessageDTO =>
    message({
      id,
      accountId: IDS.a1,
      folderId: IDS.a1Custom,
      hasAttachments: ids.length > 0,
      attachments: ids.map((a, i) => ({ id: a, messageId: id, fileName: `dosya-${i}.pdf`, mimeType: 'application/pdf', sizeBytes: 100 + i, isInline: i === 1 })),
    });

  it('creates, retrieves (in order) and deletes attachment metadata with the message, holding no bytes', async () => {
    const app = await create();
    await store(app, withAttachments('am-1', ['x-1', 'x-2', 'x-3']));
    const stored = await app.persistence.messages.findOwned(USER_A, 'am-1');
    expect(stored?.attachments.map((a) => a.id)).toEqual(['x-1', 'x-2', 'x-3']);
    expect(stored?.attachments[1]).toMatchObject({ fileName: 'dosya-1.pdf', sizeBytes: 101, isInline: true });
    expect(Object.keys(stored?.attachments[0] ?? {}).sort()).toEqual(['fileName', 'id', 'isInline', 'messageId', 'mimeType', 'sizeBytes']);
    const columns = (await app.persistence.db.all("SELECT name, type FROM pragma_table_info('attachments')")).map((c) => `${c['name']}:${c['type']}`);
    expect(columns.some((c) => c.endsWith(':BLOB'))).toBe(false); // metadata only: no binary column exists

    await store(app, withAttachments('am-1', ['x-2']));
    expect((await app.persistence.messages.findOwned(USER_A, 'am-1'))?.attachments.map((a) => a.id)).toEqual(['x-2']);
    await app.persistence.mailStore.removeMessage(a1(app), 'am-1');
    expect((await app.persistence.db.get("SELECT count(*) AS n FROM attachments WHERE id LIKE 'x-%'"))?.['n']).toBe(0);
  });

  it('is isolated per message: an attachment id cannot be claimed by a second message, and a lie about ownership is refused', async () => {
    const app = await create();
    await store(app, withAttachments('am-1', ['shared-att']));
    await expect(store(app, withAttachments('am-2', ['shared-att']))).rejects.toThrow();
    expect(await app.persistence.messages.findOwned(USER_A, 'am-2')).toBeNull(); // whole upsert rolled back
    expect((await app.persistence.messages.findOwned(USER_A, 'am-1'))?.attachments.map((a) => a.id)).toEqual(['shared-att']);
    const liar = withAttachments('am-3', ['y-1']);
    await expect(store(app, { ...liar, attachments: [{ ...(liar.attachments[0] as (typeof liar.attachments)[number]), messageId: 'am-1' }] })).rejects.toThrow(/does not belong/);
  });

  it('the internal MIME part id is stored for the future fetch but never returned', async () => {
    const app = await create();
    await app.persistence.mailStore.upsertMessage(a1(app), { message: withAttachments('am-4', ['z-1']), provider: null, attachmentParts: { 'z-1': '2.1' } });
    expect((await app.persistence.db.get("SELECT provider_part_id FROM attachments WHERE id = 'z-1'"))?.['provider_part_id']).toBe('2.1');
    expect(JSON.stringify(await app.persistence.messages.findOwned(USER_A, 'am-4'))).not.toContain('2.1');
  });
});

const searchParams = (q: string, over: Partial<{ accounts: 'all' | string; folder: { role: 'inbox' | 'trash' | 'custom'; name?: string }; attachmentsOnly: boolean; includeDeleted: boolean; after: string; before: string; cursor: string | null; limit: number }> = {}) => ({
  q,
  accounts: over.accounts === undefined || over.accounts === 'all' ? ({ kind: 'all' } as const) : ({ kind: 'account', accountId: over.accounts } as const),
  filters: {
    ...EMPTY_SEARCH_FILTERS,
    attachmentsOnly: over.attachmentsOnly ?? false,
    includeDeleted: over.includeDeleted ?? false,
    folder: over.folder === undefined ? null : over.folder.role === 'custom' ? { role: 'custom' as const, name: over.folder.name as string } : { role: over.folder.role },
  },
  dateRange: over.after === undefined && over.before === undefined ? null : { ...(over.after === undefined ? {} : { after: over.after }), ...(over.before === undefined ? {} : { before: over.before }) },
  cursor: over.cursor ?? null,
  limit: over.limit ?? 30,
});
const ids = (page: { items: Array<{ message: { id: string } }> }) => page.items.map((i) => i.message.id);

describe('search index (FTS5, mobile semantics)', () => {
  it('finds by subject, sender name, sender address, preview and plain body; prefix match; all tokens must match', async () => {
    const app = await create();
    await store(app, message({ id: 's1', accountId: IDS.a1, folderId: IDS.a1Custom, subject: 'Fatura dönemi', from: { email: 'muhasebe@firma.example', name: 'Ayşe Yılmaz' }, preview: 'ödeme hatırlatması', body: { text: 'Sözleşme numarası 12345', html: null } }));
    for (const [query, expected] of [['fatura', true], ['fat', true], ['ayse', true], ['muhasebe', true], ['odeme', true], ['sozlesme 12345', true], ['fatura yilmaz', true], ['fatura mehmet', false], ['zzz', false]] as const) {
      expect((await app.useCases.search(A, searchParams(query))).items.some((i) => i.message.id === 's1'), query).toBe(expected);
    }
  });

  it('folds Turkish exactly like the domain: "sahan" finds "Şahan", "IRMAK" finds "ırmak", "istanbul" finds "İstanbul"', async () => {
    const app = await create();
    await store(app, message({ id: 'tr1', accountId: IDS.a1, folderId: IDS.a1Custom, subject: 'Şahan ırmak İstanbul' }));
    for (const query of ['sahan', 'ŞAHAN', 'irmak', 'IRMAK', 'istanbul', 'İSTANBUL']) expect(ids(await app.useCases.search(A, searchParams(query))), query).toContain('tr1');
  });

  it('user input can never become FTS syntax: quotes, operators, wildcards and parentheses are just punctuation', async () => {
    const app = await create();
    await store(app, message({ id: 'sx', accountId: IDS.a1, folderId: IDS.a1Custom, subject: 'plain words here' }));
    for (const hostile of ['"', '"unterminated', 'a OR b', 'NEAR(a b)', '*', 'plain*', '(plain)', 'plain -words', 'col:plain', "plain'; DROP TABLE messages; --", '^plain', '{plain}']) {
      await expect(app.useCases.search(A, searchParams(hostile)), hostile).resolves.toBeDefined();
    }
    expect(ids(await app.useCases.search(A, searchParams('(plain) -words')))).toContain('sx'); // punctuation ignored, tokens still match
    expect((await app.useCases.search(A, searchParams('!!! ...'))).items).toEqual([]); // nothing searchable left
  });

  it('the index follows inserts, updates and deletes (no stale or missing rows)', async () => {
    const app = await create();
    const fts = async (term: string) => Number((await app.persistence.db.get('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?', [term]))?.['n']);
    const base = message({ id: 'sync-1', accountId: IDS.a1, folderId: IDS.a1Custom, subject: 'alfa', preview: '', body: { text: 'bravo', html: null } });
    await store(app, base);
    expect([await fts('alfa'), await fts('bravo')]).toEqual([1, 1]);
    await store(app, { ...base, subject: 'charlie', body: { text: 'delta', html: null } });
    expect([await fts('alfa'), await fts('bravo'), await fts('charlie'), await fts('delta')]).toEqual([0, 0, 1, 1]); // old terms gone
    expect(Number((await app.persistence.db.get('SELECT count(*) AS n FROM messages_fts WHERE rowid = (SELECT rowid FROM messages WHERE id = ?)', ['sync-1']))?.['n'])).toBe(1); // exactly one row
    await app.persistence.mailStore.removeMessage(a1(app), 'sync-1');
    expect([await fts('charlie'), await fts('delta')]).toEqual([0, 0]);
    const orphans = await app.persistence.db.get('SELECT count(*) AS n FROM messages_fts WHERE rowid NOT IN (SELECT rowid FROM messages)');
    expect(orphans?.['n']).toBe(0);
  });

  it('every stored message has exactly one index row, before and after churn', async () => {
    const app = await create();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 20; i++) await store(app, message({ id: `churn-${i}`, accountId: IDS.a1, folderId: IDS.a1Custom, subject: `konu ${round} ${i}` }));
      if (round === 1) for (let i = 0; i < 20; i += 2) await app.persistence.mailStore.removeMessage(a1(app), `churn-${i}`);
    }
    const { db } = app.persistence;
    expect((await db.get('SELECT count(*) AS n FROM messages'))?.['n']).toBe((await db.get('SELECT count(*) AS n FROM messages_fts'))?.['n']);
    expect((await db.get('SELECT count(*) AS n FROM messages m WHERE NOT EXISTS (SELECT 1 FROM messages_fts f WHERE f.rowid = m.rowid)'))?.['n']).toBe(0);
  });

  it('newest first, with paging; folder, trash, date and attachment filters follow the domain rules', async () => {
    const app = await create();
    const mk = (id: string, folderId: string, day: number, over: Partial<MessageDTO> = {}) =>
      store(app, message({ id, accountId: IDS.a1, folderId, subject: 'rapor', date: `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`, ...over }));
    await mk('r-inbox-old', IDS.a1Inbox, 1);
    await mk('r-custom', IDS.a1Custom, 2, { hasAttachments: true });
    await mk('r-inbox-new', IDS.a1Inbox, 3);
    await mk('r-trash', IDS.a1Trash, 4);

    expect(ids(await app.useCases.search(A, searchParams('rapor')))).toEqual(['r-inbox-new', 'r-custom', 'r-inbox-old']); // Trash excluded by default
    expect(ids(await app.useCases.search(A, searchParams('rapor', { includeDeleted: true })))).toEqual(['r-trash', 'r-inbox-new', 'r-custom', 'r-inbox-old']);
    expect(ids(await app.useCases.search(A, searchParams('rapor', { folder: { role: 'inbox' } })))).toEqual(['r-inbox-new', 'r-inbox-old']);
    expect(ids(await app.useCases.search(A, searchParams('rapor', { folder: { role: 'custom', name: 'Projeler' } })))).toEqual(['r-custom']);
    expect(ids(await app.useCases.search(A, searchParams('rapor', { attachmentsOnly: true })))).toEqual(['r-custom']);
    expect(ids(await app.useCases.search(A, searchParams('rapor', { after: '2026-09-02T00:00:00.000Z', before: '2026-09-03T23:59:59.000Z' })))).toEqual(['r-inbox-new', 'r-custom']);

    const first = await app.useCases.search(A, searchParams('rapor', { limit: 2 }));
    expect(first.nextCursor).not.toBeNull();
    const second = await app.useCases.search(A, searchParams('rapor', { limit: 2, cursor: first.nextCursor }));
    expect([...ids(first), ...ids(second)]).toEqual(['r-inbox-new', 'r-custom', 'r-inbox-old']);
    expect(second.nextCursor).toBeNull();
    expect(first.items[0]?.folder).toEqual({ id: IDS.a1Inbox, name: 'Gelen Kutusu', role: 'inbox' });
  });

  it('is scoped to the user\'s own accounts: other users\' mail never matches, and a named account is enforced', async () => {
    const app = await create();
    await app.persistence.mailStore.upsertMessage(app.access(IDS.b1, USER_B), { message: message({ id: 'b-secret', accountId: IDS.b1, folderId: IDS.b1Inbox, subject: 'gizlibelge' }), provider: null });
    await app.persistence.mailStore.upsertMessage(app.access(IDS.a2, USER_A), { message: message({ id: 'a2-doc', accountId: IDS.a2, folderId: IDS.a2Inbox, subject: 'gizlibelge' }), provider: null });
    expect(ids(await app.useCases.search(A, searchParams('gizlibelge')))).toEqual(['a2-doc']);
    expect((await failure(app.useCases.search(A, searchParams('gizlibelge', { accounts: IDS.b1 })))).code).toBe('account_not_found');
    expect(ids(await app.useCases.search(A, searchParams('gizlibelge', { accounts: IDS.a2 })))).toEqual(['a2-doc']);
  });

  it('an unknown or forged search cursor is invalid_cursor', async () => {
    const app = await create();
    expect((await failure(app.useCases.search(A, searchParams('rapor', { cursor: 'AAAA' })))).code).toBe('invalid_cursor');
  });
});

describe('batches are atomic', () => {
  it('a sync-style batch commits together, and one failing message rolls the WHOLE batch back — rows, parts and search index', async () => {
    const app = await create();
    const good = (i: number) => message({ id: `batch-${i}`, accountId: IDS.a1, folderId: IDS.a1Custom, subject: `toplu ${i}`, attachments: [{ id: `batch-att-${i}`, messageId: `batch-${i}`, fileName: 'a', mimeType: 'text/plain', sizeBytes: 1, isInline: false }] });
    await app.persistence.transactions.run(async () => {
      for (const i of [1, 2, 3]) await store(app, good(i));
    });
    expect((await app.persistence.db.get("SELECT count(*) AS n FROM messages WHERE id LIKE 'batch-%'"))?.['n']).toBe(3);

    const attempt = app.persistence.transactions.run(async () => {
      await store(app, good(4));
      await store(app, good(5));
      await store(app, message({ id: 'batch-6', accountId: IDS.a1, folderId: 'no-such-folder' })); // fails: unknown folder
    });
    await expect(attempt).rejects.toThrow();
    const { db } = app.persistence;
    expect((await db.get("SELECT count(*) AS n FROM messages WHERE id LIKE 'batch-%'"))?.['n']).toBe(3);
    expect((await db.get("SELECT count(*) AS n FROM attachments WHERE id IN ('batch-att-4', 'batch-att-5')"))?.['n']).toBe(0);
    expect((await db.get("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'toplu'"))?.['n']).toBe(3); // no index rows for the rolled-back mail
    expect((await db.get('SELECT count(*) AS n FROM messages_fts WHERE rowid NOT IN (SELECT rowid FROM messages)'))?.['n']).toBe(0);
  });

  it('a single upsert is atomic on its own: a failure half-way (bad attachment) leaves the previous version intact', async () => {
    const app = await create();
    const original = message({ id: 'atom', accountId: IDS.a1, folderId: IDS.a1Custom, subject: 'ilk hâli', to: [{ email: 'keep@example.com', name: '' }] });
    await store(app, original);
    await store(app, message({ id: 'other', accountId: IDS.a1, folderId: IDS.a1Custom, attachments: [{ id: 'taken', messageId: 'other', fileName: 'a', mimeType: 'text/plain', sizeBytes: 1, isInline: false }] }));
    const broken = { ...original, subject: 'ikinci hâli', to: [{ email: 'lost@example.com', name: '' }], attachments: [{ id: 'taken', messageId: 'atom', fileName: 'a', mimeType: 'text/plain', sizeBytes: 1, isInline: false }] };
    await expect(store(app, broken)).rejects.toThrow();
    expect(await app.persistence.messages.findOwned(USER_A, 'atom')).toMatchObject({ subject: 'ilk hâli', to: [{ email: 'keep@example.com', name: '' }] });
  });
});

/**
 * Realistic volumes, to expose obviously bad queries — not a benchmark. Timings are printed (`[perf]`) so they can be read
 * from the test output; the assertions are generous ceilings that only a scan-the-world query would break. The important
 * checks are EXPLAIN QUERY PLAN: the important list queries must use the intended indexes.
 */
import { EMPTY_MESSAGE_FILTER } from '@kaydet/domain';
import type { MessageDTO, MessageFilter, MessageListParams } from '@kaydet/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ANONYMOUS_ACTOR, NO_SESSION } from '../../application/index.ts';
import type { RequestContext } from '../../application/index.ts';
import { IDS, USER_A, message } from '../../testing/fixtures.ts';
import { createSqliteTestApplication } from '../../testing/sqlite.ts';
import type { SqliteTestApplication } from '../../testing/sqlite.ts';

const MESSAGES = 6000;
const FOLDERS = 300;
const LABELS = 200;

let app: SqliteTestApplication;
const A: RequestContext = {
  requestId: 'perf',
  actor: { kind: 'user', userId: USER_A },
  session: { status: 'active', id: 's', expiresAt: new Date('2027-01-01T00:00:00.000Z'), csrfToken: 'c' },
  metadata: { method: 'TEST', route: '/perf', clientAddress: '203.0.113.1' },
};
void ANONYMOUS_ACTOR;
void NO_SESSION;

const BIG_FOLDER = 'perf-inbox';
const timings: Record<string, number> = {};
async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  timings[name] = Math.round((performance.now() - start) * 10) / 10;
  return result;
}

const list = (over: Partial<MessageListParams> & { sort?: MessageListParams['filter']['sort'] } = {}): MessageListParams => ({
  scope: over.scope ?? { kind: 'folder', folderId: BIG_FOLDER },
  filter: { ...EMPTY_MESSAGE_FILTER, ...over.filter, ...(over.sort === undefined ? {} : { sort: over.sort }) },
  cursor: over.cursor ?? null,
  limit: over.limit ?? 30,
});

beforeAll(async () => {
  app = await createSqliteTestApplication();
  const account = app.access(IDS.a1, USER_A);
  const { mailStore, labels } = app.persistence;

  await timed('load: folders + labels', async () => {
    await app.persistence.transactions.run(async () => {
      await mailStore.upsertFolder(account, { id: BIG_FOLDER, name: 'Performans', role: 'custom', sortOrder: 100, provider: { path: 'Performans', delimiter: '.', uidValidity: 1, uidNext: null, highestModSeq: null } });
      for (let i = 0; i < FOLDERS; i++) {
        const parent = i % 10 === 0 ? '' : `Klasor${i - (i % 10)}.`;
        await mailStore.upsertFolder(account, { id: `perf-f-${i}`, name: `Klasor${i}`, role: 'custom', sortOrder: 100, provider: { path: `${parent}Klasor${i}`, delimiter: '.', uidValidity: null, uidNext: null, highestModSeq: null } });
      }
      for (let i = 0; i < LABELS; i++) await labels.save(account, { id: `perf-l-${i}`, accountId: IDS.a1, name: `Etiket ${i}`, tone: i % 15 });
    });
  });

  await timed(`load: ${MESSAGES} messages (5 recipients, attachments, labels, FTS)`, async () => {
    for (let batch = 0; batch < MESSAGES; batch += 500) {
      await app.persistence.transactions.run(async () => {
        for (let i = batch; i < Math.min(batch + 500, MESSAGES); i++) {
          const m: MessageDTO = message({
            id: `perf-m-${String(i).padStart(5, '0')}`,
            accountId: IDS.a1,
            folderId: i % 5 === 0 ? `perf-f-${i % FOLDERS}` : BIG_FOLDER,
            threadId: `perf-thread-${i % 900}`,
            from: { email: `kisi${i % 400}@ornek.example`, name: `Kişi ${i % 400} Şahin` },
            to: [{ email: `a${i}@x.example`, name: '' }, { email: `b${i}@x.example`, name: 'B' }, { email: `c${i}@x.example`, name: '' }],
            cc: [{ email: `cc${i}@x.example`, name: '' }],
            bcc: [{ email: `bcc${i}@x.example`, name: '' }],
            subject: `Konu ${i % 250} raporu ${i}`,
            preview: `önizleme metni ${i}`,
            date: new Date(Date.parse('2025-01-01T00:00:00.000Z') + i * 600_000).toISOString(),
            seen: i % 4 !== 0,
            pinned: i % 50 === 0,
            hasAttachments: i % 5 < 2,
            labels: i % 3 === 0 ? [`Etiket ${i % LABELS}`, `Etiket ${(i + 7) % LABELS}`] : [],
            body: { text: `gövde ${i} aylık toplantı notları`, html: null },
            attachments: i % 5 < 2 ? [1, 2].map((n) => ({ id: `perf-att-${i}-${n}`, messageId: `perf-m-${String(i).padStart(5, '0')}`, fileName: `dosya${n}.pdf`, mimeType: 'application/pdf', sizeBytes: 100, isInline: false })) : [],
          });
          await mailStore.upsertMessage(account, { message: m, provider: { uid: i + 1, uidValidity: 1, modSeq: null, messageIdHeader: `<perf-${i}@x>`, inReplyTo: null, references: null } });
        }
      });
    }
  });
}, 120_000);

afterAll(async () => {
  console.info(`[perf] ${JSON.stringify(timings, null, 1)}`);
  await app?.cleanup();
});

/** Runs `fn`, captures the last SQL the repository issued through `db.all`, and returns its query plan. */
async function planOf(fn: () => Promise<unknown>): Promise<string[]> {
  const spy = vi.spyOn(app.persistence.db, 'all');
  try {
    await fn();
    const selects = spy.mock.calls.filter(([sql]) => /^\s*SELECT/i.test(sql) && /FROM messages/i.test(sql) && /LIMIT/i.test(sql));
    const call = selects.at(-1);
    if (call === undefined) throw new Error('no list query captured');
    spy.mockRestore();
    const rows = await app.persistence.db.all(`EXPLAIN QUERY PLAN ${call[0]}`, [...(call[1] ?? [])]);
    return rows.map((r) => String(r['detail']));
  } finally {
    spy.mockRestore();
  }
}
const planOfSql = async (sql: string, params: Array<string | number> = []) => (await app.persistence.db.all(`EXPLAIN QUERY PLAN ${sql}`, params)).map((r) => String(r['detail']));
const scans = (plan: string[]) => plan.filter((line) => /^SCAN /.test(line) && !/USING (COVERING )?INDEX/.test(line));

describe(`with ${MESSAGES} messages, ${FOLDERS} folders and ${LABELS} labels`, () => {
  it('the data really is there', async () => {
    expect(Number((await app.persistence.db.get('SELECT count(*) AS n FROM messages'))?.['n'])).toBeGreaterThanOrEqual(MESSAGES);
    expect(Number((await app.persistence.db.get('SELECT count(*) AS n FROM message_recipients'))?.['n'])).toBeGreaterThanOrEqual(MESSAGES * 5);
    expect(Number((await app.persistence.db.get('SELECT count(*) AS n FROM attachments'))?.['n'])).toBeGreaterThan(MESSAGES / 3);
    expect(Number((await app.persistence.db.get('SELECT count(*) AS n FROM messages_fts'))?.['n'])).toBe(Number((await app.persistence.db.get('SELECT count(*) AS n FROM messages'))?.['n']));
  });

  it('folder list (dateDesc) reads the folder index, in order, without sorting or scanning', async () => {
    const plan = await planOf(() => app.persistence.messages.listPage(app.access(IDS.a1, USER_A), { scope: { kind: 'folder', folderId: BIG_FOLDER }, filter: EMPTY_MESSAGE_FILTER, page: { position: null, limit: 30 } }));
    expect(plan.join('\n')).toContain('ix_messages_folder_date');
    expect(plan.join('\n')).not.toMatch(/USE TEMP B-TREE/);
    expect(scans(plan)).toEqual([]);
  });

  it('the first page and a deep cursor page cost about the same (keyset, not offset)', async () => {
    const first = await timed('list: first page (30 of ~4800)', () => app.useCases.listMessages(A, IDS.a1, list()));
    let cursor = first.nextCursor;
    for (let i = 0; i < 100 && cursor !== null; i++) cursor = (await app.useCases.listMessages(A, IDS.a1, list({ cursor }))).nextCursor; // 3000 rows in
    const deep = await timed('list: page after 3000 rows', () => app.useCases.listMessages(A, IDS.a1, list({ cursor })));
    expect(first.items).toHaveLength(30);
    expect(deep.items).toHaveLength(30);
    expect(timings['list: first page (30 of ~4800)']).toBeLessThan(500);
    expect(timings['list: page after 3000 rows']).toBeLessThan(500);
    const plan = await planOf(() => app.persistence.messages.listPage(app.access(IDS.a1, USER_A), { scope: { kind: 'folder', folderId: BIG_FOLDER }, filter: EMPTY_MESSAGE_FILTER, page: { position: JSON.stringify(['2025-02-01T00:00:00.000Z', 'perf-m-00500']), limit: 30 } }));
    expect(plan.join('\n')).toMatch(/ix_messages_folder_date \(account_id=\? AND folder_id=\? AND \(date_utc,rowid\)<\(\?,\?\)|ix_messages_folder_date/);
    expect(scans(plan)).toEqual([]);
  });

  it('oldest-first, sender A-Z and subject A-Z use their own indexes', async () => {
    for (const [sort, index] of [['dateAsc', 'ix_messages_folder_date'], ['senderAZ', 'ix_messages_folder_sender'], ['subjectAZ', 'ix_messages_folder_subject']] as const) {
      const plan = await planOf(() => app.persistence.messages.listPage(app.access(IDS.a1, USER_A), { scope: { kind: 'folder', folderId: BIG_FOLDER }, filter: { ...EMPTY_MESSAGE_FILTER, sort }, page: { position: null, limit: 30 } }));
      expect(plan.join('\n'), sort).toContain(index);
      expect(plan.join('\n'), sort).not.toMatch(/USE TEMP B-TREE/);
    }
    await timed('list: senderAZ first page', () => app.useCases.listMessages(A, IDS.a1, list({ sort: 'senderAZ' })));
  });

  it('the pinned view uses the partial pinned index', async () => {
    const plan = await planOf(() => app.persistence.messages.listPage(app.access(IDS.a1, USER_A), { scope: { kind: 'pinned' }, filter: EMPTY_MESSAGE_FILTER, page: { position: null, limit: 30 } }));
    expect(plan.join('\n')).toContain('ix_messages_pinned_date');
    await timed('list: pinned view', () => app.useCases.listMessages(A, IDS.a1, list({ scope: { kind: 'pinned' } })));
  });

  it('unread / attachments / label filters stay index-driven (filter applied to an index walk, label via its primary key)', async () => {
    const filters: Array<[string, Partial<MessageFilter>]> = [['unread', { unread: true }], ['attachments', { attachments: true }], ['label', { label: 'Etiket 3' }]];
    for (const [name, filter] of filters) {
      const plan = await planOf(() => app.persistence.messages.listPage(app.access(IDS.a1, USER_A), { scope: { kind: 'folder', folderId: BIG_FOLDER }, filter: { ...EMPTY_MESSAGE_FILTER, ...filter }, page: { position: null, limit: 30 } }));
      expect(plan.join('\n'), name).toContain('ix_messages_folder_date');
      expect(scans(plan), name).toEqual([]);
      const page = await timed(`list: ${name} filter`, () => app.useCases.listMessages(A, IDS.a1, list({ filter: { ...EMPTY_MESSAGE_FILTER, ...filter } })));
      expect(page.items.length, name).toBeGreaterThan(0);
    }
    const labelPlan = await planOf(() => app.persistence.messages.listPage(app.access(IDS.a1, USER_A), { scope: { kind: 'folder', folderId: BIG_FOLDER }, filter: { ...EMPTY_MESSAGE_FILTER, label: 'Etiket 3' }, page: { position: null, limit: 30 } }));
    expect(labelPlan.join('\n')).toMatch(/message_labels/);
  });

  it('the folder tree with counters (300 folders) reads a covering index, not the message table', async () => {
    const plan = await planOfSql(
      `SELECT folder_id, COUNT(*) AS total, SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) AS unread FROM messages WHERE account_id = ? AND server_deleted = 0 GROUP BY folder_id`,
      [IDS.a1],
    );
    expect(plan.join('\n')).toMatch(/COVERING INDEX ix_messages_folder_seen/);
    const folders = await timed('folder tree + counters (300 folders)', () => app.persistence.folders.listByAccount(app.access(IDS.a1, USER_A)));
    expect(folders.length).toBeGreaterThan(FOLDERS);
    expect(folders.find((f) => f.id === BIG_FOLDER)?.totalCount).toBeGreaterThan(4000);
  });

  it('a whole message (recipients, body, attachments) is a handful of primary-key lookups', async () => {
    const message = await timed('getMessage (full)', () => app.persistence.messages.findOwned(USER_A, 'perf-m-00010'));
    expect(message?.cc).toHaveLength(1);
    expect(message?.attachments).toHaveLength(2);
    for (const sql of [
      "SELECT kind, email, name FROM message_recipients WHERE message_id = 'x' AND kind IN ('cc','bcc') ORDER BY kind, position",
      "SELECT plain_text FROM message_bodies WHERE message_id = 'x'",
      "SELECT id FROM attachments WHERE message_id = 'x' ORDER BY created_at, rowid",
      "SELECT m.id FROM messages m JOIN mail_accounts a ON a.id = m.account_id WHERE m.id = 'x' AND a.user_id = 'u'",
    ]) expect(scans(await planOfSql(sql)), sql).toEqual([]);
  });

  it('search: prefix tokens over the whole index, newest first, joined by rowid — and fast', async () => {
    const plan = await planOfSql(
      `SELECT m.id FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid JOIN folders fo ON fo.id = m.folder_id
       WHERE messages_fts MATCH ? AND m.account_id IN (?) AND m.server_deleted = 0 AND fo.role <> 'trash' ORDER BY m.date_utc DESC, m.id DESC LIMIT 31`,
      ['"aylik"* "toplanti"*', IDS.a1],
    );
    expect(plan.join('\n')).toMatch(/VIRTUAL TABLE INDEX/);
    expect(plan.join('\n')).toMatch(/SEARCH m USING INTEGER PRIMARY KEY \(rowid=\?\)/); // messages fetched by rowid
    const page = await timed('search: 2 tokens, newest 30 of ~6000 matches', () =>
      app.useCases.search(A, { q: 'aylık toplantı', accounts: { kind: 'all' }, filters: { attachmentsOnly: false, includeDeleted: false, folder: null }, dateRange: null, cursor: null, limit: 30 }),
    );
    expect(page.items).toHaveLength(30);
    expect(page.items[0]?.message.date >= (page.items[1]?.message.date ?? '')).toBe(true);
    await timed('search: rare token (one message)', () =>
      app.useCases.search(A, { q: 'gövde 4321', accounts: { kind: 'all' }, filters: { attachmentsOnly: false, includeDeleted: false, folder: null }, dateRange: null, cursor: null, limit: 30 }),
    );
    expect(timings['search: 2 tokens, newest 30 of ~6000 matches']).toBeLessThan(1500);
  });

  it('identity lookups are index seeks: user by identifier, session by fingerprint, account by user, draft by account', async () => {
    for (const [sql, index] of [
      ["SELECT id FROM users WHERE identifier = 'x'", 'ux_users_identifier'],
      ["SELECT id FROM sessions WHERE secret_fingerprint = 'x'", 'ux_sessions_fingerprint'],
      ["SELECT id FROM mail_accounts WHERE user_id = 'x' ORDER BY created_at, rowid", 'ux_mail_accounts_user_email'],
      ["SELECT id FROM folders WHERE account_id = 'x' AND role = 'trash'", 'ix_folders_account_role'],
      ["SELECT id FROM messages WHERE account_id = 'x' AND thread_id = 't'", 'ix_messages_thread'],
      ["SELECT id FROM messages WHERE folder_id = 'x' AND provider_uid_validity = 1 AND provider_uid = 5", 'ux_messages_provider_uid'],
      ["SELECT id FROM outbox WHERE account_id = 'x' AND state = 'queued'", 'ix_outbox_account_state'],
      ["SELECT id FROM outbox WHERE user_id = 'x' AND draft_id = 'd' ORDER BY created_at DESC", 'ix_outbox_draft'],
      ["SELECT id FROM drafts WHERE account_id = 'x' ORDER BY updated_at DESC", 'ix_drafts_account_updated'],
      ["SELECT message_id FROM message_labels WHERE label_id = 'x'", 'ix_message_labels_label'],
      ["SELECT id FROM labels WHERE account_id = 'x'", 'ux_labels_account_name'],
      ["SELECT id FROM sessions WHERE user_id = 'x' AND revoked_at IS NULL", 'ix_sessions_user_live'],
      ["SELECT id FROM sessions WHERE expires_at < 'x'", 'ix_sessions_expires'],
    ] as const) {
      const plan = await planOfSql(sql);
      expect(plan.join('\n'), sql).toContain(index);
    }
    const t = performance.now();
    for (let i = 0; i < 500; i++) await app.persistence.users.findByIdentifier('a@kaydet.test');
    timings['500 user lookups'] = Math.round((performance.now() - t) * 10) / 10;
  });
});

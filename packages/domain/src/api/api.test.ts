import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ERROR_DEFINITIONS,
  ERROR_KINDS,
  API_ERROR_CODES,
  AccountCreateRequestSchema,
  AccountSchema,
  AccountUpdateRequestSchema,
  ApiErrorResponseSchema,
  ApiErrorSchema,
  AttachmentSchema,
  COMMON_ERRORS,
  OutboxCancelResponseSchema,
  DEFAULT_PAGE_SIZE,
  DateRangeSchema,
  DraftInputSchema,
  DraftSchema,
  FolderSchema,
  FolderUpdateRequestSchema,
  LabelSchema,
  MAX_ACTION_BATCH,
  MAX_PAGE_SIZE,
  MailEventSchema,
  MessageActionsRequestSchema,
  MessageActionsResponseSchema,
  MessageListQuerySchema,
  MessagePageSchema,
  MessageSchema,
  MessageSummarySchema,
  OutboxSchema,
  SearchQuerySchema,
  SearchResultSchema,
  SessionCreateRequestSchema,
  SessionSchema,
  SignatureSchema,
  TemplateSchema,
  UndoTokenSchema,
  api,
  buildPath,
  createApiError,
  encodeMessageListQuery,
  encodeSearchQuery,
  httpStatusOf,
  isSessionError,
  messageListKey,
  pageMatchesRequest,
  pathParamNames,
} from './index.ts';
import type { ApiRouteName } from './index.ts';
import { EMPTY_MESSAGE_FILTER } from '../message/index.ts';
import { MAX_ATTACHMENT_FILE_BYTES, MAX_ATTACHMENT_TOTAL_BYTES } from '../attachment/index.ts';
import { UNDOABLE_ACTION_TYPES } from '../actions/index.ts';
import { EMPTY_SEARCH_FILTERS } from '../search/index.ts';

/** A query string survives URL encoding: percent-encode every value and decode it again, as a real request does. */
const overTheWire = (q: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(q).map(([k, v]) => [decodeURIComponent(encodeURIComponent(k)), decodeURIComponent(encodeURIComponent(v))]));

// ── fixtures ─────────────────────────────────────────────────────────────────
const addr = { email: 'ali@x.com', name: 'Ali' };
const summary = {
  id: 'm1', accountId: 'a1', folderId: 'f1', threadId: 't1',
  from: addr, to: [addr], subject: 'Konu', preview: 'Özet', date: '2026-09-30T12:00:00.000Z',
  seen: false, pinned: false, answered: false, forwarded: false, draft: false, hasAttachments: false,
  labels: [], outbox: { state: 'none' as const },
};
const attachment = { id: 'at1', messageId: 'm1', fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10, isInline: false };
const message = { ...summary, cc: [], bcc: [], body: { text: 'Merhaba', html: { content: '<p>Merhaba</p>', sanitized: true as const } }, attachments: [attachment] };
const folder = { id: 'f1', accountId: 'a1', name: 'Gelen Kutusu', role: 'inbox' as const, parentId: null, depth: 0, hasChildren: false, isFavorite: false, unreadCount: 3, totalCount: 10 };
const account = { id: 'a1', email: 'ali@x.com', displayName: '', supportsServerLabels: null, sync: { status: 'idle' as const, lastSyncAt: null } };
const draft = { id: 'd1', accountId: 'a1', to: [addr], cc: [], bcc: [], subject: '', bodyText: '', bodyHtml: null, attachments: [], source: null, messageId: null, updatedAt: '2026-09-30T12:00:00.000Z' };
const outbox = { id: 'o1', accountId: 'a1', draftId: 'd1', messageId: null, state: 'queued' as const, cancellableUntil: '2026-09-30T12:00:05.000Z', error: null };

describe('DTO schemas accept well-formed payloads', () => {
  it('parses every public DTO', () => {
    expect(AccountSchema.parse(account)).toEqual(account);
    expect(FolderSchema.parse(folder)).toEqual(folder);
    expect(LabelSchema.parse({ id: 'l1', accountId: 'a1', name: 'İş', tone: 14 }).tone).toBe(14);
    expect(AttachmentSchema.parse(attachment)).toEqual(attachment);
    expect(MessageSummarySchema.parse(summary)).toEqual(summary);
    expect(MessageSchema.parse(message)).toEqual(message);
    expect(DraftSchema.parse(draft)).toEqual(draft);
    expect(OutboxSchema.parse(outbox)).toEqual(outbox);
    expect(SearchResultSchema.parse({ message: summary, folder: { id: 'f1', name: 'Gelen Kutusu', role: 'inbox' } }).folder.role).toBe('inbox');
    expect(SignatureSchema.parse({ id: 's1', accountId: 'a1', name: 'İş', body: 'Saygılar', isDefault: true }).isDefault).toBe(true);
    expect(TemplateSchema.parse({ id: 't1', title: 'T', content: 'C', isBuiltIn: false }).title).toBe('T');
    expect(SessionSchema.parse({ authenticated: false, user: null, expiresAt: null }).authenticated).toBe(false);
  });

  it('rejects malformed values', () => {
    expect(MessageSummarySchema.safeParse({ ...summary, date: '30.09.2026' }).success).toBe(false);
    expect(MessageSummarySchema.safeParse({ ...summary, id: '' }).success).toBe(false);
    expect(FolderSchema.safeParse({ ...folder, role: 'spam' }).success).toBe(false);
    expect(FolderSchema.safeParse({ ...folder, depth: -1 }).success).toBe(false);
    expect(LabelSchema.safeParse({ id: 'l1', accountId: 'a1', name: 'x', tone: 15 }).success).toBe(false);
    expect(MessageSummarySchema.safeParse({ ...summary, outbox: { state: 'weird' } }).success).toBe(false);
  });

  it('HTML bodies carry the sanitised marker: an unsanitised body cannot be typed as this DTO', () => {
    const raw = { ...message, body: { text: null, html: { content: '<script>x</script>', sanitized: false } } };
    expect(MessageSchema.safeParse(raw).success).toBe(false);
    expect(MessageSchema.safeParse({ ...message, body: { text: null, html: null } }).success).toBe(true);
  });
});

describe('browser-safety: nothing protocol-level or secret can cross the boundary', () => {
  /** Property names that must never appear in any RESPONSE the browser receives. */
  const FORBIDDEN = [
    'uid', 'uidvalidity', 'uidnext', 'modseq', 'highestmodseq', 'path', 'encodedpath', 'delimiter', 'flags', 'rawflags',
    'password', 'passwordhash', 'secret', 'apikey', 'privatekey', 'username', 'host', 'port', 'imap', 'smtp', 'security',
    'partid', 'specialuse', 'messageidheader', 'inreplyto', 'references', 'dbid', 'rowid', 'keyword', 'imapkeyword',
  ];

  const collectKeys = (node: unknown, out: Set<string>): void => {
    if (Array.isArray(node)) return node.forEach((n) => collectKeys(n, out));
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value !== null && typeof value === 'object') {
        for (const prop of Object.keys(value)) out.add(prop.toLowerCase());
      }
      collectKeys(value, out);
    }
  };

  const jsonResponses = (Object.keys(api) as ApiRouteName[]).flatMap((name) => {
    const r = api[name].response;
    return r instanceof z.ZodType ? [[name, r] as const] : [];
  });

  it('there are JSON responses to check', () => expect(jsonResponses.length).toBeGreaterThan(20));

  it.each(jsonResponses)('%s response exposes no forbidden property', (_name, schema) => {
    const keys = new Set<string>();
    collectKeys(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }), keys);
    const leaked = [...keys].filter((k) => FORBIDDEN.includes(k));
    expect(leaked).toEqual([]);
  });

  it('events and the error model are also free of forbidden properties', () => {
    for (const schema of [MailEventSchema, ApiErrorResponseSchema]) {
      const keys = new Set<string>();
      collectKeys(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }), keys);
      expect([...keys].filter((k) => FORBIDDEN.includes(k))).toEqual([]);
    }
  });

  it('the check itself works: a schema with a forbidden key is caught', () => {
    const keys = new Set<string>();
    collectKeys(z.toJSONSchema(z.strictObject({ uid: z.number(), nested: z.strictObject({ password: z.string() }) })), keys);
    expect([...keys]).toEqual(expect.arrayContaining(['uid', 'password']));
  });

  it('strict schemas reject leaked keys instead of passing them through', () => {
    const leaks: Array<[string, z.ZodType, Record<string, unknown>, string]> = [
      ['MessageSummary', MessageSummarySchema, summary, 'uid'],
      ['Message', MessageSchema, message, 'uidValidity'],
      ['Message', MessageSchema, message, 'flags'],
      ['Folder', FolderSchema, folder, 'path'],
      ['Folder', FolderSchema, folder, 'encodedPath'],
      ['Account', AccountSchema, account, 'password'],
      ['Account', AccountSchema, account, 'imapHost'],
      ['Attachment', AttachmentSchema, attachment, 'partId'],
      ['Draft', DraftSchema, draft, 'dbId'],
      ['Session', SessionSchema, { authenticated: true, user: { id: 'u1' }, expiresAt: null }, 'token'],
      ['Outbox', OutboxSchema, outbox, 'smtpMessageId'],
    ];
    for (const [name, schema, base, key] of leaks) {
      expect(schema.safeParse(base).success, `${name} baseline`).toBe(true);
      expect(schema.safeParse({ ...base, [key]: 1 }).success, `${name} + ${key}`).toBe(false);
    }
    // Also nested: a leaked key inside the embedded summary of a message page.
    const page = { accountId: 'a1', scope: { kind: 'pinned' as const }, items: [summary], nextCursor: null };
    expect(MessagePageSchema.safeParse(page).success).toBe(true);
    expect(MessagePageSchema.safeParse({ ...page, items: [{ ...summary, uid: 4 }] }).success).toBe(false);
  });

  it('request-only secrets are never part of a response schema', () => {
    expect(AccountCreateRequestSchema.shape).toHaveProperty('password');
    expect(AccountCreateRequestSchema.shape).toHaveProperty('imap');
    expect(SessionCreateRequestSchema.shape).toHaveProperty('password');
    const keys = new Set<string>();
    for (const [, schema] of jsonResponses) collectKeys(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }), keys);
    expect(keys.has('password')).toBe(false);
  });
});

describe('route table (the contract the server phase implements)', () => {
  const routes = (Object.keys(api) as ApiRouteName[]).map((name) => [name, api[name]] as const);
  const normalise = (path: string) => path.replace(/:[A-Za-z0-9]+/g, ':p');

  it('covers every endpoint of the phase brief', () => {
    const wanted = [
      'GET /session', 'POST /session', 'DELETE /session',
      'GET /accounts', 'POST /accounts', 'PATCH /accounts/:p', 'DELETE /accounts/:p',
      'GET /accounts/:p/folders', 'POST /accounts/:p/folders', 'PATCH /accounts/:p/folders/:p', 'DELETE /accounts/:p/folders/:p',
      'GET /accounts/:p/messages', 'GET /messages/:p',
      'POST /messages/actions', 'POST /actions/:p/undo',
      'GET /messages/:p/attachments/:p',
      'PUT /drafts/:p', 'POST /drafts/:p/send',
      'POST /outbox/:p/cancel',
      'GET /search',
      'GET /events',
    ];
    const have = new Set(routes.map(([, r]) => `${r.method} ${normalise(r.path)}`));
    for (const w of wanted) expect(have.has(w), w).toBe(true);
  });

  it('every method+path is unique and every name maps to one route', () => {
    const seen = new Set<string>();
    for (const [, r] of routes) {
      const key = `${r.method} ${normalise(r.path)}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it.each(routes)('%s: path params match the params schema exactly', (_name, route) => {
    const names = pathParamNames(route.path);
    const schemaKeys = 'params' in route ? Object.keys((route.params as z.ZodObject).shape) : [];
    expect(schemaKeys.sort()).toEqual([...names].sort());
  });

  it.each(routes)('%s: declared error codes exist and are not duplicated by COMMON_ERRORS', (_name, route) => {
    for (const code of route.errors) {
      expect(API_ERROR_CODES).toContain(code);
      expect((COMMON_ERRORS as readonly string[]).includes(code), code).toBe(false);
    }
    expect(new Set(route.errors).size).toBe(route.errors.length);
  });

  it('only the session routes that must work signed out are public', () => {
    const open = routes.filter(([, r]) => r.auth === 'none').map(([n]) => n).sort();
    expect(open).toEqual(['createMailboxSession', 'createSession', 'getSession']);
  });

  it('success statuses and body kinds are coherent', () => {
    for (const [name, r] of routes) {
      if (r.status === 204) expect('kind' in r.response && r.response.kind === 'empty', name).toBe(true);
      if (r.method === 'GET') expect('body' in r, name).toBe(false);
    }
    expect(api.downloadAttachment.response).toEqual({ kind: 'binary' });
    expect(api.streamEvents.response.kind).toBe('sse');
    expect(api.uploadDraftAttachment.body).toMatchObject({ kind: 'multipart', field: 'file', streaming: true });
    expect(api.sendDraft.status).toBe(202);
  });

  it('buildPath fills and encodes parameters, and refuses missing ones', () => {
    expect(buildPath(api.listFolders, { accountId: 'a1' })).toBe('/accounts/a1/folders');
    expect(buildPath(api.updateFolder, { accountId: 'a/1', folderId: 'x y?' })).toBe('/accounts/a%2F1/folders/x%20y%3F');
    expect(buildPath(api.getSession)).toBe('/session');
    expect(() => buildPath(api.updateFolder, { accountId: 'a1' })).toThrow(/folderId/);
    expect(() => buildPath(api.getMessage, { messageId: '' })).toThrow();
  });

  it('path params are validated as ids', () => {
    const params = api.listFolders.params;
    expect(params.safeParse({ accountId: 'a1' }).success).toBe(true);
    expect(params.safeParse({ accountId: '' }).success).toBe(false);
    expect(params.safeParse({ accountId: 'a1', extra: 1 }).success).toBe(false);
  });
});

describe('message list query: account/folder scoping cannot be mixed up', () => {
  const parse = (raw: Record<string, string>) => MessageListQuerySchema.safeParse(raw);
  const filter = { unread: true, pinned: false, attachments: true, label: 'İş', sort: 'senderAZ' as const };

  it('folder scope needs a folderId', () => {
    expect(parse({ scope: 'folder' }).success).toBe(false);
    const ok = parse({ scope: 'folder', folderId: 'f1' });
    expect(ok.success && ok.data.scope).toEqual({ kind: 'folder', folderId: 'f1' });
  });

  it('pinned scope refuses a folderId (no "pinned + folder B")', () => {
    expect(parse({ scope: 'pinned', folderId: 'f1' }).success).toBe(false);
    const ok = parse({ scope: 'pinned' });
    expect(ok.success && ok.data.scope).toEqual({ kind: 'pinned' });
  });

  it('the scope is mandatory (no implicit "whatever folder")', () => {
    expect(parse({ folderId: 'f1' }).success).toBe(false);
    expect(parse({}).success).toBe(false);
  });

  it('an account id in the query is rejected: the account travels only in the path', () => {
    expect(parse({ scope: 'folder', folderId: 'f1', accountId: 'a1' }).success).toBe(false);
  });

  it('defaults: empty filter, dateDesc, no cursor, default page size', () => {
    const r = parse({ scope: 'folder', folderId: 'f1' });
    expect(r.success && r.data).toEqual({
      scope: { kind: 'folder', folderId: 'f1' }, filter: EMPTY_MESSAGE_FILTER, cursor: null, limit: DEFAULT_PAGE_SIZE,
    });
  });

  it('booleans are the literal words true/false only; sort and limit are bounded', () => {
    expect(parse({ scope: 'pinned', unread: 'true' }).success).toBe(true);
    expect(parse({ scope: 'pinned', unread: 'false' }).success).toBe(true);
    expect(parse({ scope: 'pinned', unread: '1' }).success).toBe(false);
    expect(parse({ scope: 'pinned', unread: 'yes' }).success).toBe(false);
    expect(parse({ scope: 'pinned', sort: 'random' }).success).toBe(false);
    expect(parse({ scope: 'pinned', limit: '0' }).success).toBe(false);
    expect(parse({ scope: 'pinned', limit: String(MAX_PAGE_SIZE + 1) }).success).toBe(false);
    expect(parse({ scope: 'pinned', limit: '2.5' }).success).toBe(false);
    expect(parse({ scope: 'pinned', limit: String(MAX_PAGE_SIZE) }).success).toBe(true);
  });

  it('round-trips through encode → parse for every combination of the toggles', () => {
    const scopes = [{ kind: 'folder' as const, folderId: 'f 1/ü' }, { kind: 'pinned' as const }];
    for (const scope of scopes) {
      for (const f of [EMPTY_MESSAGE_FILTER, filter]) {
        const parsed = MessageListQuerySchema.parse(overTheWire(encodeMessageListQuery({ scope, filter: f, cursor: 'c-1', limit: 50 })));
        expect(parsed).toEqual({ scope, filter: f, cursor: 'c-1', limit: 50 });
      }
    }
  });

  it('an unfiltered first page has a minimal URL', () => {
    expect(encodeMessageListQuery({ scope: { kind: 'folder', folderId: 'f1' }, filter: EMPTY_MESSAGE_FILTER })).toEqual({ scope: 'folder', folderId: 'f1' });
    expect(encodeMessageListQuery({ scope: { kind: 'pinned' }, limit: DEFAULT_PAGE_SIZE })).toEqual({ scope: 'pinned' });
  });

  it('cache keys separate accounts, folders, the pinned view and filters', () => {
    const f1 = { kind: 'folder' as const, folderId: 'f1' };
    const keys = new Set([
      messageListKey('a1', f1, EMPTY_MESSAGE_FILTER),
      messageListKey('a2', f1, EMPTY_MESSAGE_FILTER),
      messageListKey('a1', { kind: 'folder', folderId: 'f2' }, EMPTY_MESSAGE_FILTER),
      messageListKey('a1', { kind: 'pinned' }, EMPTY_MESSAGE_FILTER),
      messageListKey('a1', f1, { ...EMPTY_MESSAGE_FILTER, unread: true }),
      messageListKey('a1', f1, { ...EMPTY_MESSAGE_FILTER, label: 'İş' }),
      messageListKey('a1', f1, { ...EMPTY_MESSAGE_FILTER, sort: 'dateAsc' }),
    ]);
    expect(keys.size).toBe(7);
    expect(messageListKey('a1', f1, EMPTY_MESSAGE_FILTER)).toBe(messageListKey('a1', { ...f1 }, { ...EMPTY_MESSAGE_FILTER }));
  });

  it('a late page of a previous folder/account is recognised and can be dropped', () => {
    const page = (accountId: string, scope: { kind: 'folder'; folderId: string } | { kind: 'pinned' }) => ({ accountId, scope });
    const want = { accountId: 'a1', scope: { kind: 'folder' as const, folderId: 'f1' } };
    expect(pageMatchesRequest(page('a1', { kind: 'folder', folderId: 'f1' }), want)).toBe(true);
    expect(pageMatchesRequest(page('a1', { kind: 'folder', folderId: 'f2' }), want)).toBe(false);
    expect(pageMatchesRequest(page('a2', { kind: 'folder', folderId: 'f1' }), want)).toBe(false);
    expect(pageMatchesRequest(page('a1', { kind: 'pinned' }), want)).toBe(false);
    expect(pageMatchesRequest(page('a1', { kind: 'pinned' }), { accountId: 'a1', scope: { kind: 'pinned' } })).toBe(true);
    expect(pageMatchesRequest(page('a1', { kind: 'folder', folderId: 'f1' }), { accountId: 'a1', scope: { kind: 'pinned' } })).toBe(false);
  });
});

describe('search query', () => {
  const parse = (raw: Record<string, string>) => SearchQuerySchema.safeParse(raw);

  it('needs an explicit account scope: all, or one account', () => {
    expect(parse({ q: 'fatura' }).success).toBe(false);
    expect(parse({ q: 'fatura', accounts: 'account' }).success).toBe(false);
    expect(parse({ q: 'fatura', accounts: 'all', accountId: 'a1' }).success).toBe(false);
    const all = parse({ q: 'fatura', accounts: 'all' });
    expect(all.success && all.data.accounts).toEqual({ kind: 'all' });
    const one = parse({ q: 'fatura', accounts: 'account', accountId: 'a1' });
    expect(one.success && one.data.accounts).toEqual({ kind: 'account', accountId: 'a1' });
  });

  it('the query text is trimmed and must not be empty', () => {
    expect(parse({ q: '   ', accounts: 'all' }).success).toBe(false);
    const r = parse({ q: '  görüşme ', accounts: 'all' });
    expect(r.success && r.data.q).toBe('görüşme');
  });

  it('folder scope: custom folders need a name, standard roles must not carry one', () => {
    expect(parse({ q: 'x', accounts: 'all', folderRole: 'custom' }).success).toBe(false);
    expect(parse({ q: 'x', accounts: 'all', folderRole: 'inbox', folderName: 'Work' }).success).toBe(false);
    expect(parse({ q: 'x', accounts: 'all', folderName: 'Work' }).success).toBe(false);
    const c = parse({ q: 'x', accounts: 'all', folderRole: 'custom', folderName: 'Work' });
    expect(c.success && c.data.filters.folder).toEqual({ role: 'custom', name: 'Work' });
    const s = parse({ q: 'x', accounts: 'all', folderRole: 'sent' });
    expect(s.success && s.data.filters.folder).toEqual({ role: 'sent' });
  });

  it('date range must be ordered', () => {
    expect(parse({ q: 'x', accounts: 'all', after: '2026-09-02T00:00:00.000Z', before: '2026-09-01T00:00:00.000Z' }).success).toBe(false);
    expect(parse({ q: 'x', accounts: 'all', after: 'yesterday' }).success).toBe(false);
    const r = parse({ q: 'x', accounts: 'all', after: '2026-09-01T00:00:00.000Z' });
    expect(r.success && r.data.dateRange).toEqual({ after: '2026-09-01T00:00:00.000Z' });
    expect(DateRangeSchema.safeParse({ after: '2026-09-02T00:00:00.000Z', before: '2026-09-01T00:00:00.000Z' }).success).toBe(false);
    expect(DateRangeSchema.safeParse({}).success).toBe(true);
  });

  it('round-trips through encode → parse', () => {
    const params = {
      q: 'toplantı notları',
      accounts: { kind: 'account' as const, accountId: 'a1' },
      filters: { attachmentsOnly: true, includeDeleted: true, folder: { role: 'custom' as const, name: 'Müşteriler' } },
      dateRange: { after: '2026-01-01T00:00:00.000Z', before: '2026-02-01T00:00:00.000Z' },
      cursor: 'abc',
      limit: 10,
    };
    expect(SearchQuerySchema.parse(overTheWire(encodeSearchQuery(params)))).toEqual(params);
    const minimal = overTheWire(encodeSearchQuery({ q: 'x', accounts: { kind: 'all' } }));
    expect(minimal).toEqual({ q: 'x', accounts: 'all' });
    expect(SearchQuerySchema.parse(minimal)).toEqual({
      q: 'x', accounts: { kind: 'all' }, filters: EMPTY_SEARCH_FILTERS, dateRange: null, cursor: null, limit: DEFAULT_PAGE_SIZE,
    });
  });
});

describe('message action contract', () => {
  const req = (over: Record<string, unknown>) =>
    MessageActionsRequestSchema.safeParse({ accountId: 'a1', messageIds: ['m1', 'm2'], actions: [{ type: 'archive' }], ...over });

  it('accepts every action type', () => {
    const all = [
      { type: 'markRead' }, { type: 'markUnread' }, { type: 'pin' }, { type: 'unpin' }, { type: 'archive' }, { type: 'delete' },
      { type: 'spam' }, { type: 'restore' }, { type: 'move', folderId: 'f2' }, { type: 'label', labelId: 'l1', mode: 'add' },
      { type: 'deletePermanently', confirmed: true },
    ];
    for (const action of all) expect(req({ actions: [action] }).success, action.type).toBe(true);
  });

  it('is always scoped by an account and has at least one message and one action', () => {
    expect(MessageActionsRequestSchema.safeParse({ messageIds: ['m1'], actions: [{ type: 'pin' }] }).success).toBe(false);
    expect(req({ messageIds: [] }).success).toBe(false);
    expect(req({ actions: [] }).success).toBe(false);
    expect(req({ messageIds: ['m1', 'm1'] }).success).toBe(false);
    expect(req({ messageIds: Array.from({ length: MAX_ACTION_BATCH + 1 }, (_, i) => `m${i}`) }).success).toBe(false);
    expect(req({ messageIds: Array.from({ length: MAX_ACTION_BATCH }, (_, i) => `m${i}`) }).success).toBe(true);
  });

  it('a permanent delete must carry the literal confirmation', () => {
    expect(req({ actions: [{ type: 'deletePermanently' }] }).success).toBe(false);
    expect(req({ actions: [{ type: 'deletePermanently', confirmed: false }] }).success).toBe(false);
    expect(req({ actions: [{ type: 'deletePermanently', confirmed: 'true' }] }).success).toBe(false);
  });

  it('unknown action types and stray fields are rejected', () => {
    expect(req({ actions: [{ type: 'explode' }] }).success).toBe(false);
    expect(req({ actions: [{ type: 'markRead', extra: 1 }] }).success).toBe(false);
    expect(req({ actions: [{ type: 'move' }] }).success).toBe(false);
  });

  it('batch actions: flags + one relocation are fine (read and archive)', () => {
    expect(req({ actions: [{ type: 'markRead' }, { type: 'archive' }] }).success).toBe(true);
    expect(req({ actions: [{ type: 'label', labelId: 'l1', mode: 'add' }, { type: 'label', labelId: 'l2', mode: 'add' }] }).success).toBe(true);
  });

  it('contradictory or repeated actions are rejected', () => {
    expect(req({ actions: [{ type: 'archive' }, { type: 'delete' }] }).success).toBe(false);
    expect(req({ actions: [{ type: 'archive' }, { type: 'move', folderId: 'f' }] }).success).toBe(false);
    expect(req({ actions: [{ type: 'markRead' }, { type: 'markUnread' }] }).success).toBe(false);
    expect(req({ actions: [{ type: 'pin' }, { type: 'unpin' }] }).success).toBe(false);
    expect(req({ actions: [{ type: 'pin' }, { type: 'pin' }] }).success).toBe(false);
    expect(req({ actions: [{ type: 'label', labelId: 'l1', mode: 'add' }, { type: 'label', labelId: 'l1', mode: 'remove' }] }).success).toBe(false);
    expect(req({ actions: [{ type: 'deletePermanently', confirmed: true }, { type: 'markRead' }] }).success).toBe(false);
  });

  it('the response exposes an opaque undo token and nothing about the pending-operation queue', () => {
    const ok = {
      accountId: 'a1', appliedIds: ['m1'], failed: [],
      undo: { token: 'Zx9_-AbCdEfGhIjKlMnOpQrStUv', expiresAt: '2026-09-30T12:00:06.000Z' },
    };
    expect(MessageActionsResponseSchema.safeParse(ok).success).toBe(true);
    expect(MessageActionsResponseSchema.safeParse({ ...ok, undo: null }).success).toBe(true);
    expect(MessageActionsResponseSchema.safeParse({ ...ok, undo: { ...ok.undo, pendingOperationId: 7 } }).success).toBe(false);
    expect(MessageActionsResponseSchema.safeParse({ ...ok, pendingOperations: [] }).success).toBe(false);
    const partial = { ...ok, failed: [{ messageId: 'm2', error: createApiError('message_not_found') }] };
    expect(MessageActionsResponseSchema.safeParse(partial).success).toBe(true);
  });

  it('undo tokens are URL-safe and long enough not to be guessed', () => {
    expect(UndoTokenSchema.safeParse('short').success).toBe(false);
    expect(UndoTokenSchema.safeParse('has spaces and slashes/////////').success).toBe(false);
    expect(UndoTokenSchema.safeParse('Zx9_-AbCdEfGhIjKlMnOpQrStUv').success).toBe(true);
    expect(api.undoAction.params.safeParse({ token: 'nope' }).success).toBe(false);
  });
});

describe('request bodies', () => {
  const endpoint = { host: 'mail.example.com', port: 993, security: 'ssl' as const };

  it('account creation: valid address, both endpoints, defaults applied, unknown keys rejected', () => {
    const body = { email: 'ali@x.com', username: 'ali', password: 'pw', imap: endpoint, smtp: { ...endpoint, port: 465 } };
    const parsed = AccountCreateRequestSchema.parse(body);
    expect(parsed.displayName).toBe('');
    expect(AccountCreateRequestSchema.safeParse({ ...body, email: 'bozuk' }).success).toBe(false);
    expect(AccountCreateRequestSchema.safeParse({ ...body, password: '' }).success).toBe(false);
    expect(AccountCreateRequestSchema.safeParse({ ...body, imap: { ...endpoint, port: 0 } }).success).toBe(false);
    expect(AccountCreateRequestSchema.safeParse({ ...body, imap: { ...endpoint, security: 'tls' } }).success).toBe(false);
    expect(AccountCreateRequestSchema.safeParse({ ...body, admin: true }).success).toBe(false);
  });

  it('account update: partial but not empty', () => {
    expect(AccountUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(AccountUpdateRequestSchema.safeParse({ displayName: 'Ali' }).success).toBe(true);
    expect(AccountUpdateRequestSchema.safeParse({ imap: endpoint }).success).toBe(true);
  });

  it('folder update: partial but not empty; parentId null means "move to top level"', () => {
    expect(FolderUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(FolderUpdateRequestSchema.safeParse({ parentId: null }).success).toBe(true);
    expect(FolderUpdateRequestSchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(FolderUpdateRequestSchema.parse({ name: ' Yeni ' }).name).toBe('Yeni');
  });

  it('draft input: lenient recipients (autosave), bounded, source optional', () => {
    const input = {
      accountId: 'a1', to: [{ email: 'yarim', name: '' }], cc: [], bcc: [], subject: '', bodyText: '', bodyHtml: null,
      attachmentIds: [], source: null,
    };
    expect(DraftInputSchema.safeParse(input).success).toBe(true);
    expect(DraftInputSchema.safeParse({ ...input, source: { messageId: 'm1', mode: 'replyAll' } }).success).toBe(true);
    expect(DraftInputSchema.safeParse({ ...input, source: { messageId: 'm1', mode: 'new' } }).success).toBe(false);
    expect(DraftInputSchema.safeParse({ ...input, to: Array.from({ length: 501 }, () => addr) }).success).toBe(false);
    const withoutAccount: Record<string, unknown> = { ...input };
    delete withoutAccount.accountId;
    expect(DraftInputSchema.safeParse(withoutAccount).success).toBe(false);
  });


});

describe('server-sent events', () => {
  it('parses every event type and rejects payload data', () => {
    const events = [
      { type: 'sync.status', accountId: 'a1', status: 'error', lastSyncAt: null, error: createApiError('sync_failed_temporarily') },
      { type: 'sync.status', accountId: 'a1', status: 'idle', lastSyncAt: '2026-09-30T12:00:00.000Z', error: null },
      { type: 'folders.changed', accountId: 'a1' },
      { type: 'messages.changed', accountId: 'a1', folderIds: ['f1'] },
      { type: 'outbox.changed', accountId: 'a1', outboxId: 'o1', draftId: 'd1', state: 'sent' },
      { type: 'accounts.changed' },
      { type: 'session.ended' },
    ];
    for (const e of events) expect(MailEventSchema.safeParse(e).success, e.type).toBe(true);
    expect(MailEventSchema.safeParse({ type: 'messages.changed', accountId: 'a1', folderIds: [] }).success).toBe(false);
    expect(MailEventSchema.safeParse({ type: 'messages.changed', accountId: 'a1', folderIds: ['f1'], messages: [] }).success).toBe(false);
    expect(MailEventSchema.safeParse({ type: 'unknown' }).success).toBe(false);
    // An outbox event must name its own id, not only the draft (D8).
    expect(MailEventSchema.safeParse({ type: 'outbox.changed', accountId: 'a1', draftId: 'd1', state: 'sent' }).success).toBe(false);
  });
});

describe('error model', () => {
  it('has the nine required kinds, each used, and every code belongs to a known kind', () => {
    expect([...ERROR_KINDS].sort()).toEqual(
      ['authentication', 'authorization', 'conflict', 'network', 'not_found', 'operation_permanent', 'provider', 'sync_temporary', 'validation'],
    );
    const used = new Set(Object.values(ERROR_DEFINITIONS).map((d) => d.kind));
    expect([...used].sort()).toEqual([...ERROR_KINDS].sort());
  });

  it('statuses are consistent with the kind', () => {
    const wire = (kind: string) => Object.values(ERROR_DEFINITIONS).filter((d) => d.kind === kind && d.status !== 0);
    for (const d of wire('validation')) expect([400, 413]).toContain(d.status);
    for (const d of wire('not_found')) expect(d.status).toBe(404);
    for (const d of wire('conflict')) expect(d.status).toBe(409);
    for (const d of wire('authorization')) expect(d.status).toBe(403);
    for (const d of wire('authentication')) expect([401, 422]).toContain(d.status);
    for (const d of wire('sync_temporary')) expect(d.retryable).toBe(true);
    for (const d of wire('provider')) expect(d.status).toBeGreaterThanOrEqual(422);
  });

  it('mail-provider credential rejection is NOT a 401 (it must not sign the user out of Kaydet)', () => {
    expect(httpStatusOf('mail_credentials_rejected')).toBe(422);
    expect(isSessionError({ code: 'mail_credentials_rejected' })).toBe(false);
    expect(isSessionError({ code: 'session_expired' })).toBe(true);
    expect(isSessionError({ code: 'not_authenticated' })).toBe(true);
    expect(httpStatusOf('not_authenticated')).toBe(401);
  });

  it('every code yields a schema-valid error whose kind matches its definition', () => {
    for (const code of API_ERROR_CODES) {
      const e = createApiError(code);
      expect(ApiErrorSchema.safeParse(e).success, code).toBe(true);
      expect(e.kind).toBe(ERROR_DEFINITIONS[code].kind);
      expect(ApiErrorResponseSchema.safeParse({ error: e }).success).toBe(true);
    }
  });

  it('a mismatched kind is rejected', () => {
    expect(ApiErrorSchema.safeParse({ ...createApiError('message_not_found'), kind: 'conflict' }).success).toBe(false);
  });

  it('there is no free-text field for raw provider output; unknown keys are refused', () => {
    expect(ApiErrorSchema.safeParse({ ...createApiError('provider_rejected'), detail: '550 5.1.1 user unknown' }).success).toBe(false);
    expect(ApiErrorSchema.safeParse({ ...createApiError('provider_rejected'), stack: 'Error: …' }).success).toBe(false);
  });

  it('user-safe messages never mention protocol internals', () => {
    for (const [code, def] of Object.entries(ERROR_DEFINITIONS)) {
      expect(def.message, code).not.toMatch(/imap|smtp|uid|exception|stack|sqlite|\b[45]\d\d\b/i);
      expect(def.message.length, code).toBeGreaterThan(3);
    }
  });

  it('carries only user-visible extras (recipients, file names, fields, retry delay)', () => {
    const e = createApiError('recipient_rejected', { recipients: ['x@y.com'], requestId: 'req-1' });
    expect(e).toMatchObject({ code: 'recipient_rejected', recipients: ['x@y.com'], requestId: 'req-1', retryable: false });
    const v = createApiError('invalid_request', { fields: [{ field: 'actions.0', reason: 'unknown_type' }] });
    expect(ApiErrorSchema.safeParse(v).success).toBe(true);
    const r = createApiError('rate_limited', { retryAfterSeconds: 30 });
    expect(r.retryable).toBe(true);
    expect(createApiError('attachment_too_large', { fileNames: ['a.zip'] }).fileNames).toEqual(['a.zip']);
  });

  it('mobile wording is preserved where mobile has an equivalent', () => {
    expect(ERROR_DEFINITIONS.mail_credentials_rejected.message).toBe('E-posta adresi veya şifre hatalı.');
    expect(ERROR_DEFINITIONS.folder_exists.message).toBe('Bu adda bir klasör zaten var.');
    expect(ERROR_DEFINITIONS.system_folder_protected.message).toBe('Sistem klasörleri üzerinde bu işlem yapılamaz.');
    expect(ERROR_DEFINITIONS.invalid_folder_move.message).toBe('Klasör kendi alt klasörüne taşınamaz.');
    expect(ERROR_DEFINITIONS.quota_exceeded.message).toBe('Posta kutusu dolu. Yer açmanız gerekiyor.');
    expect(ERROR_DEFINITIONS.folder_resyncing.message).toBe('Klasör yeniden eşitleniyor.');
    expect(ERROR_DEFINITIONS.no_recipients.message).toBe('En az bir alıcı girin.');
  });
});

describe('D1: the session is a Kaydet user session, mail accounts live under it', () => {
  it('sign-in takes Kaydet credentials only — no mail credentials, no mailbox address', () => {
    expect(SessionCreateRequestSchema.safeParse({ identifier: 'ayse', password: 'pw' }).success).toBe(true);
    expect(SessionCreateRequestSchema.safeParse({ identifier: '  ', password: 'pw' }).success).toBe(false);
    expect(SessionCreateRequestSchema.safeParse({ identifier: 'ayse', password: '' }).success).toBe(false);
    expect(SessionCreateRequestSchema.safeParse({ email: 'ali@x.com', password: 'pw' }).success).toBe(false);
    expect(SessionCreateRequestSchema.safeParse({ identifier: 'ayse', password: 'pw', imap: {} }).success).toBe(false);
    expect(Object.keys(SessionCreateRequestSchema.shape).sort()).toEqual(['identifier', 'password']);
  });

  it('the session DTO carries the user id and expiry, and is signed-out consistent', () => {
    expect(SessionSchema.safeParse({ authenticated: true, user: { id: 'u1' }, expiresAt: '2026-10-01T00:00:00.000Z' }).success).toBe(true);
    expect(SessionSchema.safeParse({ authenticated: false, user: null, expiresAt: null }).success).toBe(true);
    expect(SessionSchema.safeParse({ authenticated: true, expiresAt: null }).success).toBe(false); // user is mandatory
    expect(SessionSchema.safeParse({ authenticated: true, user: { id: 'u1', email: 'x@y.com' }, expiresAt: null }).success).toBe(false);
  });

  it('mail accounts are separate entities managed under the session (add, update, remove, list, sync)', () => {
    expect(api.listAccounts.auth).toBe('session');
    expect(api.createAccount.auth).toBe('session');
    expect(api.updateAccount.auth).toBe('session');
    expect(api.deleteAccount.auth).toBe('session');
    expect(api.createAccount.body).toBe(AccountCreateRequestSchema);
  });

  it('logout and expiry: DELETE /session, session_expired and the session.ended event', () => {
    expect(api.deleteSession.method).toBe('DELETE');
    expect(isSessionError({ code: 'session_expired' })).toBe(true);
    expect(MailEventSchema.safeParse({ type: 'session.ended' }).success).toBe(true);
  });

  it('a failed Kaydet sign-in is not a lost session and is not a mail-provider failure', () => {
    expect(api.createSession.errors).toEqual(['invalid_credentials']);
    expect(ERROR_DEFINITIONS.invalid_credentials.kind).toBe('authentication');
    expect(isSessionError({ code: 'invalid_credentials' })).toBe(false);
    // Credential isolation: mail credentials are rejected by a different code, on a different route.
    expect(api.createAccount.errors).toContain('mail_credentials_rejected');
    expect(api.createSession.errors).not.toContain('mail_credentials_rejected');
  });
});

describe('D7: attachment upload contract', () => {
  const body = api.uploadDraftAttachment.body;

  it('is a streaming multipart upload with explicit limits', () => {
    expect(body).toEqual({
      kind: 'multipart', field: 'file', maxFileBytes: MAX_ATTACHMENT_FILE_BYTES, maxTotalBytes: MAX_ATTACHMENT_TOTAL_BYTES, streaming: true,
    });
    expect(MAX_ATTACHMENT_FILE_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_ATTACHMENT_TOTAL_BYTES).toBeGreaterThan(MAX_ATTACHMENT_FILE_BYTES);
  });

  it('answers with an opaque attachment id and the server\'s own file facts; every rejection is a stable code', () => {
    expect(api.uploadDraftAttachment.response).toBe(AttachmentSchema);
    expect(Object.keys(AttachmentSchema.shape).sort()).toEqual(['fileName', 'id', 'isInline', 'messageId', 'mimeType', 'sizeBytes']);
    for (const code of ['attachment_blocked_type', 'attachment_empty', 'attachment_too_large'] as const) {
      expect(api.uploadDraftAttachment.errors).toContain(code);
    }
  });
});

describe('D8: draft, outbox and message ids are separate', () => {
  it('a send operation has its own id and points back to the draft and (later) the message', () => {
    expect(OutboxSchema.safeParse({ ...outbox, draftId: undefined }).success).toBe(false);
    expect(OutboxSchema.safeParse({ ...outbox, messageId: 'm9' }).success).toBe(true);
    expect(outbox.id).not.toBe(outbox.draftId);
  });

  it('a draft can exist with no outbox operation and no message yet', () => {
    expect(DraftSchema.safeParse(draft).success).toBe(true);
    expect(DraftSchema.safeParse({ ...draft, messageId: 'm1' }).success).toBe(true);
    expect('outboxId' in DraftSchema.shape).toBe(false);
  });

  it('each identifier has its own route parameter', () => {
    expect(pathParamNames(api.putDraft.path)).toEqual(['draftId']);
    expect(pathParamNames(api.cancelOutbox.path)).toEqual(['outboxId']);
    expect(pathParamNames(api.getMessage.path)).toEqual(['messageId']);
    expect(api.sendDraft.response).toBe(OutboxSchema);
    expect(api.cancelOutbox.response).toBe(OutboxCancelResponseSchema);
  });

  it('a draft row in a list carries the draft id to open (optional; absent on ordinary mail)', () => {
    expect(MessageSummarySchema.safeParse({ ...summary, draft: true, draftId: 'd1' }).success).toBe(true);
    expect(MessageSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('discarding a draft has its own route, independent of message actions', () => {
    expect(api.deleteDraft.method).toBe('DELETE');
    expect(api.deleteDraft.path).toBe('/drafts/:draftId');
    expect(api.putDraft.errors).not.toContain('message_not_found');
  });
});

describe('D2: the body DTO is the sanitised end of the pipeline', () => {
  it('only a sanitised body type-checks; raw provider HTML has no field to live in', () => {
    expect(MessageSchema.safeParse({ ...message, body: { text: null, html: { content: '<b>x</b>', sanitized: true } } }).success).toBe(true);
    expect(MessageSchema.safeParse({ ...message, body: { text: null, html: { content: '<b>x</b>' } } }).success).toBe(false);
    expect(MessageSchema.safeParse({ ...message, body: { text: null, html: null, rawHtml: '<script>' } }).success).toBe(false);
  });
});

describe('D4: undo is decided by the server', () => {
  it('the response may or may not carry undo; the UNDOABLE set is only a hint', () => {
    const base = { accountId: 'a1', appliedIds: ['m1'], failed: [] };
    expect(MessageActionsResponseSchema.safeParse({ ...base, undo: null }).success).toBe(true);
    expect(UNDOABLE_ACTION_TYPES.has('spam')).toBe(true); // optimistic-UI hint only, not a promise
  });
});

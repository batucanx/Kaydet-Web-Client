/**
 * Contract conformance: the server validates requests with, and answers in, the schemas of
 * `packages/domain/src/api` — the single source of truth. No DTO is redeclared in apps/server.
 */
import {
  API_ERROR_CODES,
  ApiErrorResponseSchema,
  ERROR_DEFINITIONS,
  api,
  httpStatusOf,
} from '@kaydet/domain';
import type { ApiErrorCode, ApiRouteName, RouteSpec } from '@kaydet/domain';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, messageAttachmentBlobKey } from '../application/index.ts';
import { IDS, USER_A } from '../testing/fixtures.ts';
import { createHarness } from '../testing/harness.ts';
import type { Harness } from '../testing/harness.ts';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

/** Parses `json` with the contract's response schema for `name` and checks the contract's success status. */
function expectContract(name: ApiRouteName, res: { status: number; json: unknown }): void {
  const spec = api[name];
  expect(res.status, `${name} status`).toBe(spec.status);
  const schema = spec.response;
  if (schema instanceof z.ZodType) {
    const parsed = schema.safeParse(res.json);
    expect(parsed.success, `${name}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
  }
}

const draftBody = (over: Record<string, unknown> = {}) => ({
  accountId: IDS.a1,
  to: [{ email: 'friend@example.com', name: 'Friend' }],
  cc: [],
  bcc: [],
  subject: 'Konu',
  bodyText: 'Merhaba',
  bodyHtml: null,
  attachmentIds: [],
  source: null,
  ...over,
});

describe('success responses match the contract schemas and statuses', () => {
  it('session, accounts, folders, messages, search', async () => {
    h = await createHarness();
    expectContract('getSession', await h.request('GET', '/session'));
    expectContract('listAccounts', await h.request('GET', '/accounts'));
    expectContract('listFolders', await h.request('GET', `/accounts/${IDS.a1}/folders`));
    expectContract('listMessages', await h.request('GET', `/accounts/${IDS.a1}/messages`, { query: { scope: 'folder', folderId: IDS.a1Inbox } }));
    expectContract('listMessages', await h.request('GET', `/accounts/${IDS.a1}/messages`, { query: { scope: 'pinned' } }));
    expectContract('getMessage', await h.request('GET', `/messages/${IDS.m1}`));
    expectContract('search', await h.request('GET', '/search', { query: { q: 'toplantı', accounts: 'all' } }));
    expectContract('undoAction', await h.request('POST', `/actions/${'a'.repeat(24)}/undo`));
  });

  it('labels, signatures, templates', async () => {
    h = await createHarness();
    expectContract('createLabel', await h.request('POST', `/accounts/${IDS.a1}/labels`, { body: { name: 'İş', tone: 2 } }));
    expectContract('listLabels', await h.request('GET', `/accounts/${IDS.a1}/labels`));
    expectContract('putSignature', await h.request('PUT', `/accounts/${IDS.a1}/signatures/s1`, { body: { name: 'İmza', body: 'Saygılar', isDefault: true } }));
    expectContract('listSignatures', await h.request('GET', `/accounts/${IDS.a1}/signatures`));
    expectContract('putTemplate', await h.request('PUT', '/templates/t1', { body: { title: 'Merhaba', content: 'Selam' } }));
    expectContract('listTemplates', await h.request('GET', '/templates'));
    expectContract('deleteTemplate', await h.request('DELETE', '/templates/t1'));
  });

  it('drafts and outbox', async () => {
    h = await createHarness();
    expectContract('putDraft', await h.request('PUT', '/drafts/d1', { body: draftBody() }));
    const sent = await h.request('POST', '/drafts/d1/send');
    expectContract('sendDraft', sent);
    expectContract('cancelOutbox', await h.request('POST', `/outbox/${(sent.json as { id: string }).id}/cancel`));
    expectContract('deleteDraft', await h.request('DELETE', '/drafts/d1'));
  });

  it('deleting things answers 204 with an empty body', async () => {
    h = await createHarness();
    const res = await h.request('DELETE', `/accounts/${IDS.a2}`);
    expectContract('deleteAccount', res);
    expect(res.text).toBe('');
  });

  it('message actions and sync answer through a scripted mailbox with the contract shape', async () => {
    h = await createHarness({
      ports: {
        mailbox: {
          requestSync: () => Promise.resolve('started'),
          createFolder: () => Promise.reject(new Error('unused')),
          updateFolder: () => Promise.reject(new Error('unused')),
          deleteFolder: () => Promise.reject(new Error('unused')),
          applyActions: (r) => Promise.resolve({ appliedIds: r.messageIds, failed: [], undo: { token: 'u'.repeat(24), expiresAt: '2026-09-30T12:00:06.000Z' }, affectedFolderIds: [IDS.a1Inbox] }),
          undo: () => Promise.resolve({ restored: true, accountId: IDS.a1, folderIds: [IDS.a1Inbox] }),
        },
      },
    });
    expectContract('syncAccount', await h.request('POST', `/accounts/${IDS.a1}/sync`));
    const actions = await h.request('POST', '/messages/actions', { body: { accountId: IDS.a1, messageIds: [IDS.m1], actions: [{ type: 'archive' }] } });
    expectContract('applyMessageActions', actions);
    expect(actions.json).toMatchObject({ appliedIds: [IDS.m1], undo: { token: 'u'.repeat(24) } });
    expect((await h.request('POST', `/actions/${'u'.repeat(24)}/undo`)).json).toEqual({ restored: true });
  });

  it('cursor pages carry an opaque nextCursor that resumes the same list', async () => {
    h = await createHarness();
    const first = await h.request('GET', `/accounts/${IDS.a1}/messages`, { query: { scope: 'folder', folderId: IDS.a1Inbox, limit: '1' } });
    const page1 = api.listMessages.response.parse(first.json);
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const second = await h.request('GET', `/accounts/${IDS.a1}/messages`, { query: { scope: 'folder', folderId: IDS.a1Inbox, limit: '1', cursor: page1.nextCursor as string } });
    const page2 = api.listMessages.response.parse(second.json);
    expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
    expect(page2.nextCursor).toBeNull();
  });
});

describe('requests are validated with the contract schemas', () => {
  it('every route with a JSON body rejects an unexpected extra field (strict schemas) with invalid_request', async () => {
    h = await createHarness();
    const valid: Partial<Record<ApiRouteName, unknown>> = {
      createSession: { identifier: 'x', password: 'y' },
      createMailboxSession: { email: 'x@kaydet.test', password: 'y', imap: { host: 'imap.kaydet.test', port: 993, security: 'ssl' }, smtp: { host: 'smtp.kaydet.test', port: 465, security: 'ssl' } },
      createAccount: { email: 'a@example.com', username: 'a', password: 'p', imap: { host: 'imap.example.com', port: 993, security: 'ssl' }, smtp: { host: 'smtp.example.com', port: 465, security: 'ssl' } },
      updateAccount: { displayName: 'x' },
      createFolder: { name: 'Yeni', parentId: null },
      updateFolder: { isFavorite: true },
      applyMessageActions: { accountId: IDS.a1, messageIds: [IDS.m1], actions: [{ type: 'markRead' }] },
      putDraft: draftBody(),
      createLabel: { name: 'x', tone: 1 },
      putSignature: { name: 'x', body: 'y', isDefault: false },
      putTemplate: { title: 'x', content: 'y' },
    };
    for (const name of Object.keys(api) as ApiRouteName[]) {
      const spec: RouteSpec = api[name];
      if (!(spec.body instanceof z.ZodType)) continue;
      const base = valid[name];
      expect(base, `test data for ${name}`).toBeDefined();
      // The valid body must NOT be a 400 …
      const path = spec.path.replace(':accountId', IDS.a1).replace(':folderId', IDS.a1Custom).replace(':signatureId', 's1').replace(':templateId', 't1').replace(':draftId', 'd1');
      const ok = await h.request(spec.method, path, { body: base });
      expect(ok.status, `${name} with a valid body`).not.toBe(400);
      // … and the same body plus one unknown key must be.
      const extra = await h.request(spec.method, path, { body: { ...(base as object), imapUid: 1 } });
      expect(extra.status, `${name} with an extra field`).toBe(400);
      expect(ApiErrorResponseSchema.parse(extra.json).error.code).toBe('invalid_request');
    }
  });

  it('applies the contract’s cross-field rules (superRefine) — e.g. conflicting or duplicate actions', async () => {
    h = await createHarness();
    const conflict = await h.request('POST', '/messages/actions', { body: { accountId: IDS.a1, messageIds: [IDS.m1], actions: [{ type: 'markRead' }, { type: 'markUnread' }] } });
    expect(conflict.status).toBe(400);
    const unconfirmed = await h.request('POST', '/messages/actions', { body: { accountId: IDS.a1, messageIds: [IDS.m1], actions: [{ type: 'deletePermanently' }] } });
    expect(unconfirmed.status).toBe(400);
    const dup = await h.request('POST', '/messages/actions', { body: { accountId: IDS.a1, messageIds: [IDS.m1, IDS.m1], actions: [{ type: 'pin' }] } });
    expect(dup.status).toBe(400);
  });

  it('parses the query string with the contract schema: defaults applied, wire booleans only', async () => {
    h = await createHarness();
    const ok = await h.request('GET', `/accounts/${IDS.a1}/messages`, { query: { scope: 'folder', folderId: IDS.a1Inbox, unread: 'true' } });
    expect((ok.json as { items: Array<{ seen: boolean }> }).items.every((m) => !m.seen)).toBe(true);
    const bad = await h.request('GET', `/accounts/${IDS.a1}/messages`, { query: { scope: 'folder', folderId: IDS.a1Inbox, unread: 'yes' } });
    expect(bad.status).toBe(400);
    const unknown = await h.request('GET', `/accounts/${IDS.a1}/messages`, { query: { scope: 'pinned', bogus: '1' } });
    expect(unknown.status).toBe(400);
  });
});

describe('errors match the contract for every error code', () => {
  it('serialises every ApiErrorCode with its own status, kind, retry policy and message', async () => {
    for (const code of API_ERROR_CODES) {
      h = await createHarness({
        ports: {
          mailbox: {
            requestSync: () => Promise.reject(new AppError(code, { cause: new Error('internal detail that must not leak') })),
            createFolder: () => Promise.reject(new Error('unused')),
            updateFolder: () => Promise.reject(new Error('unused')),
            deleteFolder: () => Promise.reject(new Error('unused')),
            applyActions: () => Promise.reject(new Error('unused')),
            undo: () => Promise.resolve({ restored: false }),
          },
        },
      });
      const res = await h.request('POST', `/accounts/${IDS.a1}/sync`);
      const def = ERROR_DEFINITIONS[code];
      expect(res.status, code).toBe(httpStatusOf(code) === 0 ? 503 : httpStatusOf(code));
      const error = ApiErrorResponseSchema.parse(res.json).error;
      expect(error, code).toMatchObject({ code, kind: def.kind, retryable: def.retryable, message: def.message });
      expect(res.text).not.toContain('internal detail');
      await h.close();
    }
  });

  it('structured extras travel: rejected recipients, file names, field paths', async () => {
    h = await createHarness();
    await h.request('PUT', '/drafts/d-bad', { body: draftBody({ to: [{ email: 'nope', name: '' }] }) });
    const res = await h.request('POST', '/drafts/d-bad/send');
    expect(res.status).toBe(400);
    expect(ApiErrorResponseSchema.parse(res.json).error).toMatchObject({ code: 'invalid_recipient', recipients: ['nope'] });
  });

  it('every documented route error code is a real contract code', () => {
    const known = new Set<string>(API_ERROR_CODES);
    for (const name of Object.keys(api) as ApiRouteName[]) for (const code of api[name].errors) expect(known.has(code), `${name}: ${code}`).toBe(true);
    // Type-level: ApiErrorCode is what AppError accepts.
    const code: ApiErrorCode = 'account_not_found';
    expect(new AppError(code).code).toBe(code);
  });
});

describe('attachment download', () => {
  const bytes = new TextEncoder().encode('%PDF');

  async function withBlob(mime: string, fileName: string) {
    h = await createHarness();
    const message = h.memory.store.messages.find((m) => m.id === IDS.m1)!;
    message.attachments = [{ id: 'att-1', messageId: IDS.m1, fileName, mimeType: mime, sizeBytes: bytes.length, isInline: false }];
    await h.memory.blobs.put(messageAttachmentBlobKey(USER_A, IDS.m1, 'att-1'), (async function* () { yield bytes; })(), { maxBytes: 1024 });
    return h;
  }

  it('streams the bytes with nosniff and a safe disposition; a PDF may be shown inline', async () => {
    await withBlob('application/pdf', 'not.pdf');
    const res = await h.request('GET', `/messages/${IDS.m1}/attachments/att-1`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('%PDF');
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('inline');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-length']).toBe('4');
  });

  it('`download=true` forces attachment', async () => {
    await withBlob('application/pdf', 'not.pdf');
    const res = await h.request('GET', `/messages/${IDS.m1}/attachments/att-1`, { query: { download: 'true' } });
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('HTML/SVG/executables are never rendered from the server origin: attachment + octet-stream', async () => {
    for (const mime of ['text/html', 'image/svg+xml', 'application/xml', 'application/x-msdownload', 'application/octet-stream']) {
      await withBlob(mime, 'x.bin');
      const res = await h.request('GET', `/messages/${IDS.m1}/attachments/att-1`);
      expect(res.headers['content-disposition'], mime).toMatch(/^attachment;/);
      expect(res.headers['content-type'], mime).toMatch(/^(application\/octet-stream|application\/x-msdownload)$/);
      expect(res.headers['content-security-policy'], mime).toContain('sandbox');
      await h.close();
    }
  });

  it('sanitises hostile file names and declared types', async () => {
    await withBlob('text/plain; charset=evil\r\nX-Injected: 1', '..\\..\\etc/pass"wd\r\n‮gnp.exe');
    const res = await h.request('GET', `/messages/${IDS.m1}/attachments/att-1`);
    const disposition = String(res.headers['content-disposition']);
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).not.toContain('..\\');
    expect(res.headers['x-injected']).toBeUndefined();
    expect(res.headers['content-type']).toBe('application/octet-stream');
  });

  it('answers attachment_not_found when the message has no such attachment or no stored bytes', async () => {
    h = await createHarness();
    const missing = await h.request('GET', `/messages/${IDS.m1}/attachments/att-nope`);
    expect(ApiErrorResponseSchema.parse(missing.json).error.code).toBe('attachment_not_found');
    const noBlob = await h.request('GET', `/messages/${IDS.m1}/attachments/att-1`);
    expect(noBlob.status).toBe(404);
  });
});

describe('multipart upload route', () => {
  it('is registered and answers after the ownership check without reading the upload (deferred)', async () => {
    h = await createHarness();
    await h.request('PUT', '/drafts/d1', { body: draftBody() });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/drafts/d1/attachments',
      headers: { cookie: `${h.config.cookie.name}=${h.tokens.a}`, 'x-csrf-token': h.secrets.csrfToken(h.tokens.a), 'content-type': 'multipart/form-data; boundary=xyz' },
      payload: '--xyz\r\ncontent-disposition: form-data; name="file"; filename="a.txt"\r\n\r\nhello\r\n--xyz--\r\n',
    });
    expect(res.statusCode).toBe(503);
    expect(ApiErrorResponseSchema.parse(res.json()).error.code).toBe('service_unavailable');
    expect(res.headers['connection']).toBe('close');
    const anon = await h.app.inject({ method: 'POST', url: '/api/drafts/d1/attachments', headers: { 'content-type': 'multipart/form-data; boundary=xyz' }, payload: '--xyz--' });
    expect(anon.statusCode).toBe(401);
  });
});

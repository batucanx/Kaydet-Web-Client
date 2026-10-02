/**
 * Authentication boundary and account scoping, exercised through the real HTTP stack.
 *
 * Users: A owns acc-a1 and acc-a2; B owns acc-b1. The requests below are made by A unless stated otherwise.
 */
import { ApiErrorResponseSchema, api, buildPath } from '@kaydet/domain';
import type { ApiRouteName } from '@kaydet/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_SCOPED } from '../testing/account-scoped.ts';
import { IDS, USER_A } from '../testing/fixtures.ts';
import { SEED_IDENTIFIERS, SEED_PASSWORD, createHarness } from '../testing/harness.ts';
import type { Harness } from '../testing/harness.ts';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const errorOf = (res: { json: unknown }) => ApiErrorResponseSchema.parse(res.json).error;
/** An error body without the per-request id: two answers are "the same" when everything else matches. */
const withoutRequestId = (res: { json: unknown }) => {
  const { requestId: _requestId, ...rest } = errorOf(res);
  return rest;
};

/** A path for a route with every `:param` filled with a placeholder id. */
const anyPath = (name: ApiRouteName): string => {
  const spec = api[name];
  return buildPath(spec, Object.fromEntries((spec.path.match(/:([A-Za-z]+)/g) ?? []).map((p) => [p.slice(1), p === ':token' ? 'a'.repeat(24) : 'x1'])));
};

describe('anonymous requests', () => {
  it('every session route rejects a request without a session with not_authenticated (401), before validation', async () => {
    h = await createHarness();
    for (const name of Object.keys(api) as ApiRouteName[]) {
      const spec = api[name];
      if (spec.auth !== 'session') continue;
      // No body/query on purpose: the guard must answer before anything else is looked at.
      const res = await h.request(spec.method, anyPath(name), { as: 'none' });
      expect(res.status, `${name}`).toBe(401);
      expect(errorOf(res).code, name).toBe('not_authenticated');
    }
  });

  it('the two signed-out routes work without a session', async () => {
    h = await createHarness();
    const session = await h.request('GET', '/session', { as: 'none' });
    expect(session.status).toBe(200);
    expect(session.json).toEqual({ authenticated: false, user: null, expiresAt: null });
    const signIn = await h.request('POST', '/session', { as: 'none', body: { identifier: SEED_IDENTIFIERS.a, password: SEED_PASSWORD } });
    expect(signIn.status).toBe(201);
    const wrong = await h.request('POST', '/session', { as: 'none', body: { identifier: SEED_IDENTIFIERS.a, password: 'not the password' } });
    expect(wrong.status).toBe(401);
    expect(errorOf(wrong).code).toBe('invalid_credentials');
  });
});

describe('expired or unknown sessions', () => {
  it('answer session_expired on session routes and authenticated:false on GET /session', async () => {
    h = await createHarness();
    const res = await h.request('GET', '/accounts', { as: 'not-a-known-token' });
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('session_expired');
    const session = await h.request('GET', '/session', { as: 'not-a-known-token' });
    expect(session.json).toEqual({ authenticated: false, user: null, expiresAt: null });
  });

  it('a session idle for longer than the idle lifetime is expired', async () => {
    h = await createHarness();
    const token = await h.issue(USER_A);
    expect((await h.request('GET', '/accounts', { as: token })).status).toBe(200);
    h.clock.advance(h.config.session.idleTtlSeconds * 1000 + 1000);
    const res = await h.request('GET', '/accounts', { as: token });
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('session_expired');
  });

  it('GET /session reports the active user and expiry', async () => {
    h = await createHarness();
    const res = await h.request('GET', '/session');
    expect(res.json).toMatchObject({ authenticated: true, user: { id: USER_A } });
  });
});

describe('account scope: valid account', () => {
  it('lists only the acting user’s accounts', async () => {
    h = await createHarness();
    const res = await h.request('GET', '/accounts');
    expect((res.json as { items: Array<{ id: string }> }).items.map((a) => a.id)).toEqual([IDS.a1, IDS.a2]);
    const b = await h.request('GET', '/accounts', { as: 'b' });
    expect((b.json as { items: Array<{ id: string }> }).items.map((a) => a.id)).toEqual([IDS.b1]);
  });

  it('serves account-scoped data for an owned account', async () => {
    h = await createHarness();
    const folders = await h.request('GET', `/accounts/${IDS.a1}/folders`);
    expect(folders.status).toBe(200);
    expect((folders.json as { items: Array<{ accountId: string }> }).items.every((f) => f.accountId === IDS.a1)).toBe(true);
  });
});



describe('account scope: an account of another user, or a nonexistent one', () => {
  it('answers account_not_found (404) on every account-scoped route — and the two cases are indistinguishable', async () => {
    h = await createHarness();
    const drafts = h.memory.store.drafts.size;
    for (const [name, method, url, body, query] of ACCOUNT_SCOPED(IDS.b1)) {
      const foreign = await h.request(method, url, { ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
      const [, , missingUrl, missingBody, missingQuery] = ACCOUNT_SCOPED('acc-does-not-exist').find((r) => r[0] === name)!;
      const missing = await h.request(method, missingUrl, { ...(missingBody === undefined ? {} : { body: missingBody }), ...(missingQuery === undefined ? {} : { query: missingQuery }) });

      expect(foreign.status, `${name} (foreign)`).toBe(404);
      expect(errorOf(foreign).code, name).toBe('account_not_found');
      expect(missing.status, `${name} (missing)`).toBe(404);
      expect(withoutRequestId(foreign), `${name}: foreign must look exactly like missing`).toEqual(withoutRequestId(missing));
    }
    expect(h.memory.store.drafts.size).toBe(drafts); // nothing was written for a foreign account
    expect(h.events.published).toEqual([]);
  });

  it('never uses `forbidden`, so existence is not revealed', async () => {
    h = await createHarness();
    const res = await h.request('GET', `/accounts/${IDS.b1}/folders`);
    expect(res.text).not.toContain('forbidden');
    expect(res.status).not.toBe(403);
  });

  it('a foreign account survives a delete attempt', async () => {
    h = await createHarness();
    expect((await h.request('DELETE', `/accounts/${IDS.b1}`)).status).toBe(404);
    expect(h.memory.store.accounts.some((a) => a.account.id === IDS.b1)).toBe(true);
  });

  it('with no actor at all the answer is not_authenticated, not account_not_found', async () => {
    h = await createHarness();
    const res = await h.request('GET', `/accounts/${IDS.a1}/folders`, { as: 'none' });
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('not_authenticated');
  });
});

describe('ids reached without an account in the path', () => {
  it('a message of another user is message_not_found, exactly like a missing one', async () => {
    h = await createHarness();
    const foreign = await h.request('GET', `/messages/${IDS.mB1}`);
    const missing = await h.request('GET', '/messages/msg-does-not-exist');
    expect(foreign.status).toBe(404);
    expect(withoutRequestId(foreign)).toEqual(withoutRequestId(missing));
    expect(errorOf(foreign).code).toBe('message_not_found');
    expect((await h.request('GET', `/messages/${IDS.m1}`)).status).toBe(200);
  });

  it('an attachment of another user’s message is not reachable', async () => {
    h = await createHarness();
    const res = await h.request('GET', `/messages/${IDS.mB1}/attachments/att-1`);
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('message_not_found');
  });

  it('a folder of another account or user cannot be used as a message-list scope', async () => {
    h = await createHarness();
    for (const folderId of [IDS.a2Inbox, IDS.b1Inbox, 'fld-nope']) {
      const res = await h.request('GET', `/accounts/${IDS.a1}/messages`, { query: { scope: 'folder', folderId } });
      expect(res.status, folderId).toBe(404);
      expect(errorOf(res).code).toBe('folder_not_found');
    }
  });

  it('messages sent to the action endpoint: other user’s → message_not_found; other own account’s → message_scope_mismatch', async () => {
    h = await createHarness();
    const foreign = await h.request('POST', '/messages/actions', { body: { accountId: IDS.a1, messageIds: [IDS.mB1], actions: [{ type: 'markRead' }] } });
    expect(foreign.status).toBe(404);
    expect(errorOf(foreign).code).toBe('message_not_found');
    const mixed = await h.request('POST', '/messages/actions', { body: { accountId: IDS.a1, messageIds: [IDS.m1, IDS.mA2], actions: [{ type: 'markRead' }] } });
    expect(mixed.status).toBe(409);
    expect(errorOf(mixed).code).toBe('message_scope_mismatch');
  });

  it('a draft reply source must be the caller’s own message', async () => {
    h = await createHarness();
    const draft = (source: unknown) => ({ accountId: IDS.a1, to: [], cc: [], bcc: [], subject: '', bodyText: '', bodyHtml: null, attachmentIds: [], source });
    const foreign = await h.request('PUT', '/drafts/d-src', { body: draft({ messageId: IDS.mB1, mode: 'reply' }) });
    expect(errorOf(foreign).code).toBe('message_not_found');
    expect((await h.request('PUT', '/drafts/d-src', { body: draft({ messageId: IDS.m1, mode: 'reply' }) })).status).toBe(200);
  });
});

describe('per-user namespaces', () => {
  it('drafts with the same client-generated id do not collide or leak between users', async () => {
    h = await createHarness();
    const draft = (accountId: string, subject: string) => ({ accountId, to: [], cc: [], bcc: [], subject, bodyText: '', bodyHtml: null, attachmentIds: [], source: null });
    expect((await h.request('PUT', '/drafts/shared-id', { body: draft(IDS.a1, 'A') })).status).toBe(200);
    expect((await h.request('PUT', '/drafts/shared-id', { as: 'b', body: draft(IDS.b1, 'B') })).status).toBe(200);
    // B deleting its draft leaves A's alone; B cannot delete what only A has.
    expect((await h.request('DELETE', '/drafts/shared-id', { as: 'b' })).status).toBe(204);
    expect((await h.request('DELETE', '/drafts/shared-id', { as: 'b' })).status).toBe(404);
    expect((await h.request('DELETE', '/drafts/shared-id')).status).toBe(204);
  });

  it('quick templates belong to the user', async () => {
    h = await createHarness();
    await h.request('PUT', '/templates/t1', { body: { title: 'Merhaba', content: 'Selam' } });
    expect((await h.request('GET', '/templates', { as: 'b' })).json).toEqual({ items: [] });
    expect((await h.request('DELETE', '/templates/t1', { as: 'b' })).status).toBe(404);
    expect(((await h.request('GET', '/templates')).json as { items: unknown[] }).items).toHaveLength(1);
  });

  it('send operations cannot be cancelled by another user', async () => {
    h = await createHarness();
    await h.request('PUT', '/drafts/d1', { body: { accountId: IDS.a1, to: [{ email: 'x@example.com', name: '' }], cc: [], bcc: [], subject: 's', bodyText: 'b', bodyHtml: null, attachmentIds: [], source: null } });
    const sent = await h.request('POST', '/drafts/d1/send');
    const outboxId = (sent.json as { id: string }).id;
    const other = await h.request('POST', `/outbox/${outboxId}/cancel`, { as: 'b' });
    expect(other.status).toBe(404);
    expect(errorOf(other).code).toBe('outbox_item_not_found');
  });
});

describe('cross-account search', () => {
  it('"all accounts" means all of the user’s accounts, never other users’', async () => {
    h = await createHarness();
    const own = await h.request('GET', '/search', { query: { q: 'ikinci', accounts: 'all' } });
    expect((own.json as { items: Array<{ message: { id: string } }> }).items.map((i) => i.message.id)).toEqual([IDS.mA2]);
    const foreign = await h.request('GET', '/search', { query: { q: 'başka kullanıcı', accounts: 'all' } });
    expect((foreign.json as { items: unknown[] }).items).toEqual([]);
  });
});

describe('account deletion', () => {
  it('removes an owned account and announces accounts.changed to that user only', async () => {
    h = await createHarness();
    expect((await h.request('DELETE', `/accounts/${IDS.a2}`)).status).toBe(204);
    expect(h.events.published).toEqual([{ userId: USER_A, event: { type: 'accounts.changed' } }]);
    expect((await h.request('GET', `/accounts/${IDS.a2}/folders`)).status).toBe(404);
  });
});

/**
 * Use cases against ports, without HTTP. Ports are the in-memory adapters plus spies/fakes where a test needs to
 * script a failure or observe a call.
 */
import { UNDO_SEND_WINDOW_MS } from '@kaydet/domain';
import type { DraftInputDTO } from '@kaydet/domain';
import { describe, expect, it, vi } from 'vitest';
import type { ApplicationPorts, MailboxPort, RequestContext } from './index.ts';
import { AppError, ANONYMOUS_ACTOR, NO_SESSION } from './index.ts';
import { IDS, USER_A, USER_B } from '../testing/fixtures.ts';
import { accountsWith, createTestApplication } from '../testing/harness.ts';

const ctxFor = (userId: string | null, requestId = 'req-test'): RequestContext => ({
  requestId,
  actor: userId === null ? ANONYMOUS_ACTOR : { kind: 'user', userId },
  session: userId === null ? NO_SESSION : { status: 'active', id: 's', expiresAt: new Date('2027-01-01T00:00:00.000Z'), csrfToken: 'csrf' },
  metadata: { method: 'TEST', route: '/test', clientAddress: '203.0.113.9' },
});
const A = ctxFor(USER_A);

async function setup(overrides: Partial<ApplicationPorts> = {}) {
  const mailbox: MailboxPort = {
    requestSync: vi.fn(() => Promise.resolve('started' as const)),
    createFolder: vi.fn((_account, request) =>
      Promise.resolve({ id: 'fld-new', accountId: IDS.a1, name: request.name, role: 'custom' as const, parentId: request.parentId, depth: 0, hasChildren: false, isFavorite: false, unreadCount: 0, totalCount: 0 }),
    ),
    updateFolder: vi.fn(() => Promise.reject(new Error('not scripted'))),
    deleteFolder: vi.fn(() => Promise.resolve()),
    applyActions: vi.fn((request) => Promise.resolve({ appliedIds: request.messageIds, failed: [], undo: null, affectedFolderIds: [IDS.a1Inbox] })),
    undo: vi.fn(() => Promise.resolve({ restored: false as const })),
  };
  const app = await createTestApplication({ ports: { mailbox, ...overrides } });
  return { useCases: app.useCases, memory: app.memory, clock: app.clock, events: app.events, mailbox };
}

const draftInput = (over: Partial<DraftInputDTO> = {}): DraftInputDTO => ({
  accountId: IDS.a1,
  to: [{ email: 'friend@example.com', name: '' }],
  cc: [],
  bcc: [],
  subject: 'Konu',
  bodyText: 'Merhaba',
  bodyHtml: null,
  attachmentIds: [],
  source: null,
  ...over,
});

const rejection = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected the use case to fail');
};

describe('authorization in use cases', () => {
  it('requires an actor: anonymous → not_authenticated, expired → session_expired', async () => {
    const { useCases } = await setup();
    expect((await rejection(useCases.listAccounts(ctxFor(null)))).code).toBe('not_authenticated');
    const expired: RequestContext = { ...ctxFor(null), session: { status: 'expired' } };
    expect((await rejection(useCases.listAccounts(expired))).code).toBe('session_expired');
  });

  it('resolves accounts only through the acting user (valid / foreign / missing)', async () => {
    const { useCases } = await setup();
    expect((await useCases.listFolders(A, IDS.a1)).items.length).toBeGreaterThan(0);
    expect((await rejection(useCases.listFolders(A, IDS.b1))).code).toBe('account_not_found');
    expect((await rejection(useCases.listFolders(A, 'nope'))).code).toBe('account_not_found');
    expect((await rejection(useCases.listFolders(ctxFor(null), IDS.a1))).code).toBe('not_authenticated');
  });

  it('account-scoped ports demand an AuthorizedAccount: a raw id does not type-check', async () => {
    const { memory } = await setup();
    // @ts-expect-error — `AuthorizedAccount` can only be obtained from `AccountAccess.authorize`
    void memory.folders.listByAccount(IDS.a1);
    // @ts-expect-error — a forged structural object is rejected too (the brand symbol is not exported)
    void memory.folders.listByAccount({ id: IDS.a1, userId: USER_A, email: 'a1@example.com' });
  });
});

describe('failure handling', () => {
  it('a repository failure becomes internal_error carrying the operation name and the original cause', async () => {
    const boom = new Error('SQLITE_BUSY: database is locked');
    const { useCases } = await setup({ accounts: accountsWith({ listByUser: () => Promise.reject(boom) }) });
    const error = await rejection(useCases.listAccounts(A));
    expect(error.code).toBe('internal_error');
    expect(error.operation).toBe('accounts.list');
    expect(error.options.cause).toBe(boom);
  });

  it('a mail-provider failure keeps its contract code and gets the operation name; no event is published', async () => {
    const { useCases, mailbox, events } = await setup();
    vi.mocked(mailbox.createFolder).mockRejectedValueOnce(new AppError('provider_rejected', { cause: new Error('NO [CANNOT] Mailbox exists') }));
    const error = await rejection(useCases.createFolder(A, IDS.a1, { name: 'Yeni', parentId: null }));
    expect(error).toMatchObject({ code: 'provider_rejected', kind: 'provider' });
    expect(error.operation).toBe('folders.create');
    expect(events.published).toEqual([]);
  });

  it('an unexpected (non-AppError) mail adapter failure is internal_error, not a provider code', async () => {
    const { useCases, mailbox } = await setup();
    vi.mocked(mailbox.requestSync).mockRejectedValueOnce(new TypeError('x is undefined'));
    expect((await rejection(useCases.syncAccount(A, IDS.a1))).code).toBe('internal_error');
  });

  it('errors keep their original operation when they pass through nested use cases', async () => {
    const { useCases } = await setup();
    const error = await rejection(useCases.getMessage(A, 'nope'));
    expect(error).toMatchObject({ code: 'message_not_found', operation: 'messages.get' });
  });
});

describe('event publication', () => {
  it('publishes folders.changed after a successful folder change, addressed to the account owner', async () => {
    const { useCases, events } = await setup();
    await useCases.createFolder(A, IDS.a1, { name: 'Yeni', parentId: null });
    expect(events.published).toEqual([{ userId: USER_A, event: { type: 'folders.changed', accountId: IDS.a1 } }]);
  });

  it('publishes accounts.changed only after the account was removed', async () => {
    const { useCases, events, memory } = await setup();
    const seen: number[] = [];
    events.subscribe(() => seen.push(memory.store.accounts.filter((a) => a.account.id === IDS.a2).length));
    await useCases.deleteAccount(A, IDS.a2);
    expect(seen).toEqual([0]); // the subscriber already sees it gone
  });

  it('a failing subscriber does not fail the use case', async () => {
    const { useCases, events } = await setup();
    events.subscribe(() => {
      throw new Error('subscriber bug');
    });
    await expect(useCases.deleteAccount(A, IDS.a2)).resolves.toBeUndefined();
  });

  it('message actions publish messages.changed with de-duplicated folder ids, and nothing when nothing was applied', async () => {
    const { useCases, mailbox, events } = await setup();
    vi.mocked(mailbox.applyActions).mockResolvedValueOnce({ appliedIds: [IDS.m1, IDS.m2], failed: [], undo: null, affectedFolderIds: [IDS.a1Inbox, IDS.a1Inbox, IDS.a1Custom] });
    await useCases.applyMessageActions(A, { accountId: IDS.a1, messageIds: [IDS.m1, IDS.m2], actions: [{ type: 'markRead' }] });
    expect(events.published).toEqual([{ userId: USER_A, event: { type: 'messages.changed', accountId: IDS.a1, folderIds: [IDS.a1Inbox, IDS.a1Custom] } }]);

    events.published.length = 0;
    vi.mocked(mailbox.applyActions).mockResolvedValueOnce({ appliedIds: [], failed: [{ messageId: IDS.m1, code: 'provider_unreachable' }], undo: null, affectedFolderIds: [] });
    await useCases.applyMessageActions(A, { accountId: IDS.a1, messageIds: [IDS.m1], actions: [{ type: 'markRead' }] });
    expect(events.published).toEqual([]);
  });
});

describe('folders', () => {
  it('protects system folders, refuses deleting a folder with children and moving one into its own subtree', async () => {
    const { useCases, mailbox } = await setup();
    expect((await rejection(useCases.deleteFolder(A, IDS.a1, IDS.a1Inbox))).code).toBe('system_folder_protected');
    expect((await rejection(useCases.updateFolder(A, IDS.a1, IDS.a1Inbox, { name: 'Başka' }))).code).toBe('system_folder_protected');
    expect((await rejection(useCases.deleteFolder(A, IDS.a1, IDS.a1Parent))).code).toBe('folder_has_children');
    expect((await rejection(useCases.updateFolder(A, IDS.a1, IDS.a1Parent, { parentId: IDS.a1Child }))).code).toBe('invalid_folder_move');
    expect((await rejection(useCases.updateFolder(A, IDS.a1, IDS.a1Parent, { parentId: IDS.a1Parent }))).code).toBe('invalid_folder_move');
    expect((await rejection(useCases.createFolder(A, IDS.a1, { name: 'x', parentId: 'nope' }))).code).toBe('folder_not_found');
    expect(mailbox.deleteFolder).not.toHaveBeenCalled();
    expect(mailbox.createFolder).not.toHaveBeenCalled();
  });

  it('a system folder may still be marked favourite (a local preference)', async () => {
    const { useCases, mailbox } = await setup();
    vi.mocked(mailbox.updateFolder).mockResolvedValueOnce((await useCases.listFolders(A, IDS.a1)).items[0]!);
    await expect(useCases.updateFolder(A, IDS.a1, IDS.a1Inbox, { isFavorite: true })).resolves.toBeDefined();
  });
});

describe('message list pagination', () => {
  const many = (memory: Awaited<ReturnType<typeof setup>>['memory']) => {
    for (let i = 0; i < 5; i++) {
      memory.store.messages.push({ ...memory.store.messages[0]!, id: `bulk-${i}`, folderId: IDS.a1Custom, date: `2026-08-0${i + 1}T00:00:00.000Z` });
    }
  };
  const params = (folderId: string, over: { cursor?: string | null; limit?: number } = {}) => ({
    scope: { kind: 'folder' as const, folderId },
    filter: { unread: false, pinned: false, attachments: false, label: null, sort: 'dateDesc' as const },
    cursor: over.cursor ?? null,
    limit: over.limit ?? 2,
  });

  it('walks a list with cursors and ends with nextCursor null', async () => {
    const { useCases, memory } = await setup();
    many(memory);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = await useCases.listMessages(A, IDS.a1, params(IDS.a1Custom, { cursor }));
      expect(page).toMatchObject({ accountId: IDS.a1, scope: { kind: 'folder', folderId: IDS.a1Custom } });
      seen.push(...page.items.map((m) => m.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(['bulk-4', 'bulk-3', 'bulk-2', 'bulk-1', 'bulk-0']);
  });

  it('rejects a cursor from another folder or a tampered one: rows can never leak across lists', async () => {
    const { useCases, memory } = await setup();
    many(memory);
    const first = await useCases.listMessages(A, IDS.a1, params(IDS.a1Custom));
    expect(first.nextCursor).not.toBeNull();
    const otherFolder = await rejection(useCases.listMessages(A, IDS.a1, params(IDS.a1Inbox, { cursor: first.nextCursor })));
    expect(otherFolder.code).toBe('invalid_cursor');
    expect((await rejection(useCases.listMessages(A, IDS.a1, params(IDS.a1Custom, { cursor: 'AAAA' })))).code).toBe('invalid_cursor');
  });

  it('never returns provider concepts: summaries carry no body, cc/bcc or attachments', async () => {
    const { useCases } = await setup();
    const page = await useCases.listMessages(A, IDS.a1, params(IDS.a1Inbox, { limit: 10 }));
    for (const item of page.items) expect(Object.keys(item)).not.toEqual(expect.arrayContaining(['body', 'cc', 'attachments']));
  });
});

describe('message actions', () => {
  it('reports unknown ids per message and still applies to the known ones', async () => {
    const { useCases, mailbox } = await setup();
    const res = await useCases.applyMessageActions(A, { accountId: IDS.a1, messageIds: [IDS.m1, 'ghost'], actions: [{ type: 'pin' }] });
    expect(mailbox.applyActions).toHaveBeenCalledWith(expect.objectContaining({ messageIds: [IDS.m1] }));
    expect(res.appliedIds).toEqual([IDS.m1]);
    expect(res.failed).toEqual([expect.objectContaining({ messageId: 'ghost', error: expect.objectContaining({ code: 'message_not_found' }) })]);
  });

  it('maps per-message provider failures to contract errors', async () => {
    const { useCases, mailbox } = await setup();
    vi.mocked(mailbox.applyActions).mockResolvedValueOnce({ appliedIds: [IDS.m1], failed: [{ messageId: IDS.m2, code: 'provider_unreachable' }], undo: null, affectedFolderIds: [IDS.a1Inbox] });
    const res = await useCases.applyMessageActions(A, { accountId: IDS.a1, messageIds: [IDS.m1, IDS.m2], actions: [{ type: 'archive' }] });
    expect(res.failed[0]?.error).toMatchObject({ code: 'provider_unreachable', kind: 'provider', retryable: true });
  });

  it('requires deletePermanently in Trash (mobile rule) and rejects other actions on drafts, without calling the mailbox', async () => {
    const { useCases, mailbox } = await setup();
    expect((await rejection(useCases.applyMessageActions(A, { accountId: IDS.a1, messageIds: [IDS.mTrash], actions: [{ type: 'delete' }] }))).code).toBe('permanent_delete_requires_confirmation');
    expect((await rejection(useCases.applyMessageActions(A, { accountId: IDS.a1, messageIds: [IDS.mDraft], actions: [{ type: 'archive' }] }))).code).toBe('invalid_action_combination');
    expect(mailbox.applyActions).not.toHaveBeenCalled();
    await useCases.applyMessageActions(A, { accountId: IDS.a1, messageIds: [IDS.mTrash], actions: [{ type: 'deletePermanently', confirmed: true }] });
    expect(mailbox.applyActions).toHaveBeenCalledOnce();
  });

  it('checks move targets and labels belong to the account', async () => {
    const { useCases, mailbox } = await setup();
    expect((await rejection(useCases.applyMessageActions(A, { accountId: IDS.a1, messageIds: [IDS.m1], actions: [{ type: 'move', folderId: IDS.a2Inbox }] }))).code).toBe('folder_not_found');
    expect((await rejection(useCases.applyMessageActions(A, { accountId: IDS.a1, messageIds: [IDS.m1], actions: [{ type: 'label', labelId: 'ghost', mode: 'add' }] }))).code).toBe('label_not_found');
    expect(mailbox.applyActions).not.toHaveBeenCalled();
  });

  it('undo is scoped to the acting user and announces the restored folders', async () => {
    const { useCases, mailbox, events } = await setup();
    vi.mocked(mailbox.undo).mockResolvedValueOnce({ restored: true, accountId: IDS.a1, folderIds: [IDS.a1Inbox] });
    expect(await useCases.undoAction(A, 'a'.repeat(24))).toEqual({ restored: true });
    expect(mailbox.undo).toHaveBeenCalledWith(USER_A, 'a'.repeat(24));
    expect(events.published).toEqual([{ userId: USER_A, event: { type: 'messages.changed', accountId: IDS.a1, folderIds: [IDS.a1Inbox] } }]);
    expect(await useCases.undoAction(A, 'b'.repeat(24))).toEqual({ restored: false });
  });
});

describe('drafts and send (queueing only)', () => {
  it('stores a draft under the user, stamping the time from the clock', async () => {
    const { useCases, clock } = await setup();
    const draft = await useCases.putDraft(A, 'd1', draftInput());
    expect(draft).toMatchObject({ id: 'd1', accountId: IDS.a1, messageId: null, updatedAt: clock.now().toISOString() });
  });

  it('refuses attachment ids that were not uploaded to this draft', async () => {
    const { useCases } = await setup();
    expect((await rejection(useCases.putDraft(A, 'd1', draftInput({ attachmentIds: ['att-x'] })))).code).toBe('attachment_not_found');
  });

  it('send validates recipients: none → no_recipients, malformed → invalid_recipient (with the address)', async () => {
    const { useCases, events } = await setup();
    await useCases.putDraft(A, 'd-none', draftInput({ to: [] }));
    expect((await rejection(useCases.sendDraft(A, 'd-none'))).code).toBe('no_recipients');
    await useCases.putDraft(A, 'd-bad', draftInput({ to: [{ email: 'not-an-address', name: '' }] }));
    const bad = await rejection(useCases.sendDraft(A, 'd-bad'));
    expect(bad.code).toBe('invalid_recipient');
    expect(bad.options.recipients).toEqual(['not-an-address']);
    expect((await rejection(useCases.sendDraft(A, 'ghost'))).code).toBe('draft_not_found');
    expect(events.published).toEqual([]);
  });

  it('send queues an outbox operation with its own id and an undo window, and announces it — it does not send', async () => {
    const { useCases, events, clock } = await setup();
    const draft = await useCases.putDraft(A, 'd1', draftInput());
    const outbox = await useCases.sendDraft(A, 'd1');
    expect(outbox).toMatchObject({ accountId: IDS.a1, draftId: 'd1', messageId: null, state: 'queued', error: null });
    expect(outbox.id).not.toBe(draft.id);
    expect(outbox.cancellableUntil).toBe(new Date(clock.now().getTime() + UNDO_SEND_WINDOW_MS).toISOString());
    expect(events.published).toEqual([{ userId: USER_A, event: { type: 'outbox.changed', accountId: IDS.a1, outboxId: outbox.id, draftId: 'd1', state: 'queued' } }]);
  });

  it('a queued draft cannot be sent again, edited or deleted (draft_already_sent)', async () => {
    const { useCases } = await setup();
    await useCases.putDraft(A, 'd1', draftInput());
    await useCases.sendDraft(A, 'd1');
    expect((await rejection(useCases.sendDraft(A, 'd1'))).code).toBe('draft_already_sent');
    expect((await rejection(useCases.putDraft(A, 'd1', draftInput({ subject: 'Yeni' })))).code).toBe('draft_already_sent');
    expect((await rejection(useCases.deleteDraft(A, 'd1'))).code).toBe('draft_already_sent');
  });

  it('cancel within the undo window returns the draft; after it, cancelled:false is a normal outcome', async () => {
    const { useCases, clock, events } = await setup();
    await useCases.putDraft(A, 'd1', draftInput());
    const first = await useCases.sendDraft(A, 'd1');
    const cancelled = await useCases.cancelOutbox(A, first.id);
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.draft?.id).toBe('d1');
    expect(events.published.at(-1)?.event).toMatchObject({ type: 'outbox.changed', state: 'none' });
    // The draft is editable again and can be sent anew.
    const second = await useCases.sendDraft(A, 'd1');
    clock.advance(UNDO_SEND_WINDOW_MS + 1);
    expect(await useCases.cancelOutbox(A, second.id)).toEqual({ cancelled: false, draft: null });
    expect((await rejection(useCases.cancelOutbox(A, 'ghost'))).code).toBe('outbox_item_not_found');
  });

  it('attachment upload is deferred, after ownership is checked', async () => {
    const { useCases } = await setup();
    expect((await rejection(useCases.uploadDraftAttachment(A, 'ghost'))).code).toBe('draft_not_found');
    await useCases.putDraft(A, 'd1', draftInput());
    expect((await rejection(useCases.uploadDraftAttachment(A, 'd1'))).code).toBe('service_unavailable');
    expect((await rejection(useCases.uploadDraftAttachment(ctxFor(USER_B), 'd1'))).code).toBe('draft_not_found');
  });
});

describe('labels, signatures, templates', () => {
  it('label names are unique per account, compared the way Turkish text is folded', async () => {
    const { useCases } = await setup();
    const label = await useCases.createLabel(A, IDS.a1, { name: 'Kişisel', tone: 3 });
    expect(label).toMatchObject({ accountId: IDS.a1, name: 'Kişisel', tone: 3 });
    expect((await rejection(useCases.createLabel(A, IDS.a1, { name: 'kisisel', tone: 1 }))).code).toBe('label_exists');
    await expect(useCases.createLabel(A, IDS.a2, { name: 'Kişisel', tone: 1 })).resolves.toBeDefined(); // other account: fine
    await useCases.deleteLabel(A, IDS.a1, label.id);
    expect((await rejection(useCases.deleteLabel(A, IDS.a1, label.id))).code).toBe('label_not_found');
  });

  it('a new default signature clears the default flag on the others', async () => {
    const { useCases } = await setup();
    await useCases.putSignature(A, IDS.a1, 's1', { name: 'Bir', body: '1', isDefault: true });
    await useCases.putSignature(A, IDS.a1, 's2', { name: 'İki', body: '2', isDefault: true });
    const { items } = await useCases.listSignatures(A, IDS.a1);
    expect(items.filter((s) => s.isDefault).map((s) => s.id)).toEqual(['s2']);
    expect((await rejection(useCases.deleteSignature(A, IDS.a1, 'ghost'))).code).toBe('signature_not_found');
  });

  it('templates are an idempotent upsert that keeps the built-in badge', async () => {
    const { useCases, memory } = await setup();
    memory.store.templates.push({ userId: USER_A, template: { id: 'built', title: 'Hazır', content: 'x', isBuiltIn: true } });
    const edited = await useCases.putTemplate(A, 'built', { title: 'Düzenlendi', content: 'y' });
    expect(edited).toEqual({ id: 'built', title: 'Düzenlendi', content: 'y', isBuiltIn: true });
    expect((await useCases.putTemplate(A, 'new', { title: 'T', content: 'c' })).isBuiltIn).toBe(false);
  });
});

describe('sessions (use-case level; the full security matrix is in security/)', () => {
  it('getSession is derived from the context, works signed out, and carries the CSRF token only when signed in', async () => {
    const { useCases } = await setup();
    expect(await useCases.getSession(ctxFor(null))).toEqual({ session: { authenticated: false, user: null, expiresAt: null }, csrfToken: null });
    expect(await useCases.getSession(A)).toEqual({
      session: { authenticated: true, user: { id: USER_A }, expiresAt: '2027-01-01T00:00:00.000Z' },
      csrfToken: 'csrf',
    });
  });

  it('sign-out needs a session', async () => {
    const { useCases } = await setup();
    expect((await rejection(useCases.deleteSession(ctxFor(null)))).code).toBe('not_authenticated');
  });
});

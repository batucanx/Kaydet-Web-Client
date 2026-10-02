/**
 * The route table: every endpoint of the future API with its method, path, auth requirement, request
 * (params/query/body) and response schemas, success status and the error codes it can produce.
 *
 * This phase defines the contract ONLY. Nothing here starts a server or makes a request; the server phase
 * implements handlers against these entries and the web client builds requests from them, so neither invents
 * a shape while coding.
 *
 * Conventions
 *  - Paths are relative to the API base (deployment concern, e.g. `/api`). Path params are `:name`.
 *  - Auth: the Kaydet session cookie (HttpOnly, SameSite, Secure) — `auth: 'session'` on everything except the
 *    two session routes that must work while signed out. (Cookie/CSRF details belong to the auth phase.)
 *  - Errors: every non-2xx body is `{ error: ApiError }` (`api/errors.ts`). `COMMON_ERRORS` can occur on every
 *    session route and are not repeated per route.
 *  - Ids are opaque strings; lists are `{ items: [...] }`; timestamps are ISO-8601 UTC.
 */
import { z } from 'zod';
import { MessageActionsRequestSchema, MessageActionsResponseSchema, UndoResponseSchema, UndoTokenSchema } from './actions.ts';
import { MAX_ATTACHMENT_FILE_BYTES, MAX_ATTACHMENT_TOTAL_BYTES } from '../attachment/index.ts';
import { IdSchema } from './common.ts';
import {
  AccountSchema,
  AttachmentSchema,
  DraftInputSchema,
  DraftSchema,
  FolderSchema,
  LabelSchema,
  MessagePageSchema,
  MessageSchema,
  OutboxSchema,
  SearchPageSchema,
  SessionSchema,
  SignatureSchema,
  TemplateSchema,
  listOf,
} from './dto.ts';
import type { ApiErrorCode } from './errors.ts';
import { MailEventSchema } from './events.ts';
import { AttachmentDownloadQuerySchema, MessageListQuerySchema, SearchQuerySchema } from './queries.ts';
import {
  AccountCreateRequestSchema,
  AccountUpdateRequestSchema,
  FolderCreateRequestSchema,
  FolderUpdateRequestSchema,
  LabelCreateRequestSchema,
  OutboxCancelResponseSchema,
  SessionCreateRequestSchema, MailboxSessionCreateRequestSchema,
  SignatureUpsertRequestSchema,
  SyncResponseSchema,
  TemplateUpsertRequestSchema,
} from './requests.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Non-JSON responses/bodies. */
export type EmptyResponse = { readonly kind: 'empty' };
export type BinaryResponse = { readonly kind: 'binary' };
export type SseResponse = { readonly kind: 'sse'; readonly event: z.ZodType };
/**
 * Multipart request body. `field` is the single file part; `maxFileBytes`/`maxTotalBytes` are the contract's
 * ceilings (see `attachment/`); `streaming: true` means the server must validate and store the part as a stream
 * and must not require the whole file in memory.
 */
export type MultipartBody = {
  readonly kind: 'multipart';
  readonly field: string;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly streaming: true;
};

export interface RouteSpec {
  readonly method: HttpMethod;
  readonly path: string;
  readonly auth: 'none' | 'session';
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType | MultipartBody;
  readonly response: z.ZodType | EmptyResponse | BinaryResponse | SseResponse;
  /** HTTP status of the success response. */
  readonly status: 200 | 201 | 202 | 204;
  /** Route-specific error codes (in addition to `COMMON_ERRORS`). */
  readonly errors: readonly ApiErrorCode[];
}

const defineRoute = <const R extends RouteSpec>(spec: R): R => spec;

/**
 * Possible on every route (`not_authenticated`/`session_expired` naturally only where `auth: 'session'`).
 * `createSession` and `getSession` can additionally fail with `rate_limited`/`service_unavailable` like any other.
 */
export const COMMON_ERRORS = [
  'invalid_request',
  'not_authenticated',
  'session_expired',
  'forbidden',
  'rate_limited',
  'service_unavailable',
  'request_timeout',
  'internal_error',
] as const satisfies readonly ApiErrorCode[];

// Path-parameter schemas.
const accountParams = z.strictObject({ accountId: IdSchema });
const folderParams = z.strictObject({ accountId: IdSchema, folderId: IdSchema });
const labelParams = z.strictObject({ accountId: IdSchema, labelId: IdSchema });
const signatureParams = z.strictObject({ accountId: IdSchema, signatureId: IdSchema });
const templateParams = z.strictObject({ templateId: IdSchema });
const messageParams = z.strictObject({ messageId: IdSchema });
const attachmentParams = z.strictObject({ messageId: IdSchema, attachmentId: IdSchema });
const draftParams = z.strictObject({ draftId: IdSchema });
const draftAttachmentParams = z.strictObject({ draftId: IdSchema, attachmentId: IdSchema });
const undoParams = z.strictObject({ token: UndoTokenSchema });
const outboxParams = z.strictObject({ outboxId: IdSchema });

const EMPTY: EmptyResponse = { kind: 'empty' };

export const api = {
  // ── Session ─────────────────────────────────────────────────────────────
  /** Current session state. Works signed out (answers `authenticated: false`, `user: null`). */
  getSession: defineRoute({
    method: 'GET', path: '/session', auth: 'none', response: SessionSchema, status: 200, errors: [],
  }),
  /** Sign in to Kaydet (decision D1: a Kaydet user, not a mailbox); sets the session cookie. */
  createSession: defineRoute({
    method: 'POST', path: '/session', auth: 'none', body: SessionCreateRequestSchema, response: SessionSchema, status: 201,
    errors: ['invalid_credentials'],
  }),
  /** Sign in with a mailbox (e-mail + password + IMAP/SMTP endpoints); finds or creates the Kaydet user; sets the session cookie. */
  createMailboxSession: defineRoute({
    method: 'POST', path: '/session/mailbox', auth: 'none', body: MailboxSessionCreateRequestSchema, response: SessionSchema, status: 201,
    errors: ['mail_credentials_rejected', 'provider_unreachable', 'provider_tls_failed'],
  }),
  deleteSession: defineRoute({
    method: 'DELETE', path: '/session', auth: 'session', response: EMPTY, status: 204, errors: [],
  }),

  // ── Accounts ────────────────────────────────────────────────────────────
  listAccounts: defineRoute({
    method: 'GET', path: '/accounts', auth: 'session', response: listOf(AccountSchema), status: 200, errors: [],
  }),
  /** Verifies the credentials against the provider before storing anything. */
  createAccount: defineRoute({
    method: 'POST', path: '/accounts', auth: 'session', body: AccountCreateRequestSchema, response: AccountSchema, status: 201,
    errors: ['account_exists', 'mail_credentials_rejected', 'provider_unreachable', 'provider_tls_failed'],
  }),
  updateAccount: defineRoute({
    method: 'PATCH', path: '/accounts/:accountId', auth: 'session', params: accountParams, body: AccountUpdateRequestSchema,
    response: AccountSchema, status: 200,
    errors: ['account_not_found', 'mail_credentials_rejected', 'provider_unreachable', 'provider_tls_failed'],
  }),
  deleteAccount: defineRoute({
    method: 'DELETE', path: '/accounts/:accountId', auth: 'session', params: accountParams, response: EMPTY, status: 204,
    errors: ['account_not_found'],
  }),
  /** Refresh: ask the server to sync the account now. Progress arrives on `/events`. */
  syncAccount: defineRoute({
    method: 'POST', path: '/accounts/:accountId/sync', auth: 'session', params: accountParams, response: SyncResponseSchema,
    status: 202, errors: ['account_not_found'],
  }),

  // ── Folders ─────────────────────────────────────────────────────────────
  /** All folders of the account in tree (display) order, with unread counters. */
  listFolders: defineRoute({
    method: 'GET', path: '/accounts/:accountId/folders', auth: 'session', params: accountParams,
    response: listOf(FolderSchema), status: 200, errors: ['account_not_found'],
  }),
  createFolder: defineRoute({
    method: 'POST', path: '/accounts/:accountId/folders', auth: 'session', params: accountParams,
    body: FolderCreateRequestSchema, response: FolderSchema, status: 201,
    errors: ['account_not_found', 'folder_not_found', 'invalid_folder_name', 'folder_exists', 'invalid_folder_move', 'provider_unreachable', 'provider_rejected'],
  }),
  updateFolder: defineRoute({
    method: 'PATCH', path: '/accounts/:accountId/folders/:folderId', auth: 'session', params: folderParams,
    body: FolderUpdateRequestSchema, response: FolderSchema, status: 200,
    errors: ['account_not_found', 'folder_not_found', 'invalid_folder_name', 'folder_exists', 'invalid_folder_move', 'system_folder_protected', 'provider_unreachable', 'provider_rejected'],
  }),
  deleteFolder: defineRoute({
    method: 'DELETE', path: '/accounts/:accountId/folders/:folderId', auth: 'session', params: folderParams, response: EMPTY,
    status: 204, errors: ['account_not_found', 'folder_not_found', 'folder_has_children', 'system_folder_protected', 'provider_unreachable', 'provider_rejected'],
  }),

  // ── Messages ────────────────────────────────────────────────────────────
  /** One page of a folder (or the pinned view). Scope, filter and sort come from the query. */
  listMessages: defineRoute({
    method: 'GET', path: '/accounts/:accountId/messages', auth: 'session', params: accountParams, query: MessageListQuerySchema,
    response: MessagePageSchema, status: 200,
    errors: ['account_not_found', 'folder_not_found', 'invalid_cursor', 'folder_resyncing', 'sync_failed_temporarily', 'provider_unreachable'],
  }),
  getMessage: defineRoute({
    method: 'GET', path: '/messages/:messageId', auth: 'session', params: messageParams, response: MessageSchema, status: 200,
    errors: ['message_not_found', 'provider_unreachable', 'sync_failed_temporarily'],
  }),

  // ── Message actions ─────────────────────────────────────────────────────
  applyMessageActions: defineRoute({
    method: 'POST', path: '/messages/actions', auth: 'session', body: MessageActionsRequestSchema,
    response: MessageActionsResponseSchema, status: 200,
    errors: ['account_not_found', 'message_not_found', 'message_scope_mismatch', 'folder_not_found', 'label_not_found', 'invalid_action_combination', 'permanent_delete_requires_confirmation', 'provider_unreachable'],
  }),
  /** Reverts the move/delete of a previous action while its undo window is open; `restored: false` after. */
  undoAction: defineRoute({
    method: 'POST', path: '/actions/:token/undo', auth: 'session', params: undoParams, response: UndoResponseSchema, status: 200,
    errors: [],
  }),

  // ── Attachments ─────────────────────────────────────────────────────────
  /** Raw bytes with `Content-Type`, `Content-Disposition`, `X-Content-Type-Options: nosniff`. */
  downloadAttachment: defineRoute({
    method: 'GET', path: '/messages/:messageId/attachments/:attachmentId', auth: 'session', params: attachmentParams,
    query: AttachmentDownloadQuerySchema, response: { kind: 'binary' }, status: 200,
    errors: ['message_not_found', 'attachment_not_found', 'provider_unreachable'],
  }),

  // ── Drafts / outbox ─────────────────────────────────────────────────────
  /** Load an existing draft by its client-generated id. */
  getDraft: defineRoute({
    method: 'GET', path: '/drafts/:draftId', auth: 'session', params: draftParams, response: DraftSchema,
    status: 200, errors: ['draft_not_found'],
  }),
  /**
   * Idempotent upsert with a CLIENT-generated draft id (autosave). The draft id is its own identifier: it is
   * neither a message id nor an outbox id (D8).
   */
  putDraft: defineRoute({
    method: 'PUT', path: '/drafts/:draftId', auth: 'session', params: draftParams, body: DraftInputSchema, response: DraftSchema,
    status: 200, errors: ['account_not_found', 'attachment_not_found', 'draft_already_sent'],
  }),
  /**
   * Validates recipients, then creates an OUTBOX operation (its own id) from the draft, with an undo window.
   * Responds when queued, not when sent. The draft stays addressable until the send succeeds.
   */
  sendDraft: defineRoute({
    method: 'POST', path: '/drafts/:draftId/send', auth: 'session', params: draftParams, response: OutboxSchema, status: 202,
    errors: ['draft_not_found', 'draft_already_sent', 'no_recipients', 'invalid_recipient', 'attachment_missing', 'recipient_rejected'],
  }),
  /**
   * Multipart upload of ONE file per request (part `file`), decision D7. Contract:
   *  - the server validates while STREAMING the part; it must not need the whole file in memory, and stops
   *    reading as soon as a limit is exceeded (`attachment_too_large`);
   *  - the browser-supplied MIME type and file name are UNTRUSTED: the server derives the type from the bytes
   *    and stores a sanitised display name; the response carries the server's values;
   *  - blocked/allowed policy is `attachment/` (`attachmentRejection`: extension list + detected content),
   *    enforced by the server regardless of what the browser checked;
   *  - the result identifies the file by an OPAQUE attachment id; no storage location is ever exposed;
   *  - limits: `MAX_ATTACHMENT_FILE_BYTES` per file and `MAX_ATTACHMENT_TOTAL_BYTES` per draft (values taken
   *    from mobile's share policy; the server phase may enforce lower ones). Storage provider: server phase.
   */
  uploadDraftAttachment: defineRoute({
    method: 'POST', path: '/drafts/:draftId/attachments', auth: 'session', params: draftParams,
    body: { kind: 'multipart', field: 'file', maxFileBytes: MAX_ATTACHMENT_FILE_BYTES, maxTotalBytes: MAX_ATTACHMENT_TOTAL_BYTES, streaming: true },
    response: AttachmentSchema, status: 201,
    errors: ['draft_not_found', 'attachment_blocked_type', 'attachment_empty', 'attachment_too_large'],
  }),
  deleteDraftAttachment: defineRoute({
    method: 'DELETE', path: '/drafts/:draftId/attachments/:attachmentId', auth: 'session', params: draftAttachmentParams,
    response: EMPTY, status: 204, errors: ['draft_not_found', 'attachment_not_found'],
  }),
  /** Discard a draft (and its uploaded attachments). Not possible once a send is in flight for it. */
  deleteDraft: defineRoute({
    method: 'DELETE', path: '/drafts/:draftId', auth: 'session', params: draftParams, response: EMPTY, status: 204,
    errors: ['draft_not_found', 'draft_already_sent'],
  }),
  /** Undo send: cancel an OUTBOX operation by its own id; on success the content is a draft again. */
  cancelOutbox: defineRoute({
    method: 'POST', path: '/outbox/:outboxId/cancel', auth: 'session', params: outboxParams, response: OutboxCancelResponseSchema,
    status: 200, errors: ['outbox_item_not_found'],
  }),

  // ── Search ──────────────────────────────────────────────────────────────
  search: defineRoute({
    method: 'GET', path: '/search', auth: 'session', query: SearchQuerySchema, response: SearchPageSchema, status: 200,
    errors: ['account_not_found', 'invalid_cursor'],
  }),

  // ── Events ──────────────────────────────────────────────────────────────
  streamEvents: defineRoute({
    method: 'GET', path: '/events', auth: 'session', response: { kind: 'sse', event: MailEventSchema }, status: 200, errors: [],
  }),

  // ── Labels ──────────────────────────────────────────────────────────────
  listLabels: defineRoute({
    method: 'GET', path: '/accounts/:accountId/labels', auth: 'session', params: accountParams, response: listOf(LabelSchema),
    status: 200, errors: ['account_not_found'],
  }),
  createLabel: defineRoute({
    method: 'POST', path: '/accounts/:accountId/labels', auth: 'session', params: accountParams, body: LabelCreateRequestSchema,
    response: LabelSchema, status: 201, errors: ['account_not_found', 'label_exists'],
  }),
  deleteLabel: defineRoute({
    method: 'DELETE', path: '/accounts/:accountId/labels/:labelId', auth: 'session', params: labelParams, response: EMPTY,
    status: 204, errors: ['account_not_found', 'label_not_found'],
  }),

  // ── Signatures ──────────────────────────────────────────────────────────
  listSignatures: defineRoute({
    method: 'GET', path: '/accounts/:accountId/signatures', auth: 'session', params: accountParams,
    response: listOf(SignatureSchema), status: 200, errors: ['account_not_found'],
  }),
  /** Idempotent upsert with a client-generated id. Setting `isDefault` clears it on the other signatures. */
  putSignature: defineRoute({
    method: 'PUT', path: '/accounts/:accountId/signatures/:signatureId', auth: 'session', params: signatureParams,
    body: SignatureUpsertRequestSchema, response: SignatureSchema, status: 200, errors: ['account_not_found'],
  }),
  deleteSignature: defineRoute({
    method: 'DELETE', path: '/accounts/:accountId/signatures/:signatureId', auth: 'session', params: signatureParams,
    response: EMPTY, status: 204, errors: ['account_not_found', 'signature_not_found'],
  }),

  // ── Quick templates ─────────────────────────────────────────────────────
  listTemplates: defineRoute({
    method: 'GET', path: '/templates', auth: 'session', response: listOf(TemplateSchema), status: 200, errors: [],
  }),
  putTemplate: defineRoute({
    method: 'PUT', path: '/templates/:templateId', auth: 'session', params: templateParams, body: TemplateUpsertRequestSchema,
    response: TemplateSchema, status: 200, errors: [],
  }),
  deleteTemplate: defineRoute({
    method: 'DELETE', path: '/templates/:templateId', auth: 'session', params: templateParams, response: EMPTY, status: 204,
    errors: ['template_not_found'],
  }),
} as const;

export type ApiRouteName = keyof typeof api;
export type ApiRoute<N extends ApiRouteName> = (typeof api)[N];

type Infer<S, Wire extends 'input' | 'output'> = S extends z.ZodType ? (Wire extends 'input' ? z.input<S> : z.output<S>) : undefined;

/** Path params, as the caller supplies them. */
export type RouteParams<N extends ApiRouteName> = ApiRoute<N> extends { params: infer P } ? Infer<P, 'input'> : undefined;
/** Query string, as WRITTEN on the wire (flat strings). Parse with the route's `query` schema on the server. */
export type RouteQueryInput<N extends ApiRouteName> = ApiRoute<N> extends { query: infer Q } ? Infer<Q, 'input'> : undefined;
/** Request body, as the caller supplies it. */
export type RouteBody<N extends ApiRouteName> = ApiRoute<N> extends { body: infer B } ? Infer<B, 'input'> : undefined;
/** Response body as received (parsed JSON). */
export type RouteResponse<N extends ApiRouteName> = ApiRoute<N>['response'] extends z.ZodType
  ? z.output<ApiRoute<N>['response']>
  : undefined;

/** Names of the `:param` segments of a path template, in order. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1] as string);
}

/** Fills a path template: `/accounts/:accountId/folders` + `{accountId:'a1'}` → `/accounts/a1/folders`. */
export function buildPath(route: { readonly path: string }, params: Readonly<Record<string, string>> = {}): string {
  return route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') throw new Error(`Missing path parameter "${name}" for ${route.path}`);
    return encodeURIComponent(value);
  });
}

/**
 * Request bodies and non-DTO responses of the API.
 *
 * Secrets travel in ONE direction only: `password` appears in requests (browser → server, over TLS) and in no
 * response schema, ever (`api.test.ts` walks every response schema to prove it). Connection settings are
 * write-only too: the server stores them, the browser never gets them back.
 */
import { z } from 'zod';
import { isValidEmail } from '../address/index.ts';
import { TONE_COUNT } from '../labels/index.ts';
import { IdSchema } from './common.ts';
import { DraftSchema } from './dto.ts';

// ── Session ────────────────────────────────────────────────────────────────

/**
 * Sign-in to KAYDET (decision D1): a separate Kaydet user, NOT a login to one mailbox.
 *
 *   Kaydet user ── Session ── Mail account A, B, C … (added/removed later via /accounts)
 *
 * `identifier` is the user's Kaydet login name; its format (and how users are created) is owned by the auth
 * phase and deliberately not fixed here. Mail credentials never appear in this request: they are supplied per
 * account (`AccountCreateRequest`) and stay isolated from the session credentials.
 */
export const SessionCreateRequestSchema = z.strictObject({
  identifier: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1024),
});
export type SessionCreateRequest = z.infer<typeof SessionCreateRequestSchema>;

// ── Accounts ───────────────────────────────────────────────────────────────

export const SOCKET_SECURITIES = ['none', 'startTls', 'ssl'] as const;
export const SocketSecuritySchema = z.enum(SOCKET_SECURITIES);
export type SocketSecurity = z.infer<typeof SocketSecuritySchema>;

/** Mobile defaults: IMAP 993 + SSL, SMTP 465 + SSL (587 is offered as STARTTLS). */
export const DEFAULT_IMAP_PORT = 993;
export const DEFAULT_SMTP_PORT = 465;

/** Server endpoint settings. WRITE-ONLY: accepted in requests, never returned. */
export const MailEndpointSchema = z.strictObject({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  security: SocketSecuritySchema,
});
export type MailEndpoint = z.infer<typeof MailEndpointSchema>;

/**
 * Sign-in with a MAILBOX (the web client's login screen): the address + password are verified against the mail
 * provider using the supplied IMAP/SMTP endpoints; on success the server finds or creates the Kaydet user that
 * belongs to this address on this server, attaches the account and opens a session. The IMAP/SMTP login name is
 * the e-mail address itself.
 */
export const MailboxSessionCreateRequestSchema = z.strictObject({
  email: z.string().refine(isValidEmail, { message: 'invalid e-mail address' }),
  password: z.string().min(1).max(1024),
  imap: MailEndpointSchema,
  smtp: MailEndpointSchema,
});
export type MailboxSessionCreateRequest = z.infer<typeof MailboxSessionCreateRequestSchema>;

export const AccountCreateRequestSchema = z.strictObject({
  email: z.string().refine(isValidEmail, { message: 'invalid e-mail address' }),
  displayName: z.string().trim().max(200).default(''),
  /** Login name for IMAP/SMTP (often the address, not always). */
  username: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1024),
  imap: MailEndpointSchema,
  smtp: MailEndpointSchema,
});
export type AccountCreateRequest = z.infer<typeof AccountCreateRequestSchema>;

export const AccountUpdateRequestSchema = z
  .strictObject({
    displayName: z.string().trim().max(200),
    username: z.string().trim().min(1).max(320),
    password: z.string().min(1).max(1024),
    imap: MailEndpointSchema,
    smtp: MailEndpointSchema,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'at least one field is required' });
export type AccountUpdateRequest = z.infer<typeof AccountUpdateRequestSchema>;

/** `POST /accounts/:accountId/sync` — the pull-to-refresh / refresh button. */
export const SyncResponseSchema = z.strictObject({ status: z.enum(['started', 'already_running']) });
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

// ── Folders ────────────────────────────────────────────────────────────────

/** `parentId: null` = top level of the account namespace (the server applies any namespace prefix itself). */
export const FolderCreateRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(255),
  parentId: IdSchema.nullable(),
});
export type FolderCreateRequest = z.infer<typeof FolderCreateRequestSchema>;

/** Rename, move and/or (un)favourite. Absent = unchanged; `parentId: null` moves to the top level. */
export const FolderUpdateRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(255),
    parentId: IdSchema.nullable(),
    isFavorite: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'at least one field is required' });
export type FolderUpdateRequest = z.infer<typeof FolderUpdateRequestSchema>;

// ── Labels / signatures / templates ────────────────────────────────────────

export const LabelCreateRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  tone: z.number().int().min(0).max(TONE_COUNT - 1),
});
export type LabelCreateRequest = z.infer<typeof LabelCreateRequestSchema>;

export const SignatureUpsertRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  body: z.string().max(20_000),
  isDefault: z.boolean(),
});
export type SignatureUpsertRequest = z.infer<typeof SignatureUpsertRequestSchema>;

export const TemplateUpsertRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(100),
  content: z.string().max(20_000),
});
export type TemplateUpsertRequest = z.infer<typeof TemplateUpsertRequestSchema>;

// ── Outbox ─────────────────────────────────────────────────────────────────

/**
 * `POST /outbox/:outboxId/cancel`. `cancelled: false` means it was too late (already sent / handed to SMTP);
 * that is a normal outcome, not an error. On success the message is back as a draft.
 */
export const OutboxCancelResponseSchema = z.strictObject({
  cancelled: z.boolean(),
  draft: DraftSchema.nullable(),
});
export type OutboxCancelResponse = z.infer<typeof OutboxCancelResponseSchema>;

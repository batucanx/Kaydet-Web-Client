/**
 * Browser-safe DTOs.
 *
 * What the browser receives is APPLICATION-level data only. Nothing here can carry: IMAP UID / UIDVALIDITY /
 * MODSEQ, encoded IMAP paths, raw IMAP flags, IMAP/SMTP connection info, passwords or keys, raw protocol
 * structures, or internal database row ids. Ids are opaque strings issued by the server. Object schemas are
 * strict, so an extra key is a validation error rather than a silent leak (see `api.test.ts`).
 *
 * Field vocabulary follows Kaydet: `pinned` = IMAP `\Flagged` = "Sabitle"; a folder has a `role`
 * (mobile `SpecialUse`); labels are referenced by NAME on messages (as on mobile) and by id for actions.
 * Derived facts the client can compute with the domain helpers are NOT duplicated in the payload
 * (attachment kind, initials, avatar tone, display dates).
 */
import { z } from 'zod';
import { FOLDER_ROLES } from '../folder/index.ts';
import { TONE_COUNT } from '../labels/index.ts';
import { CursorSchema, EmailAddressSchema, IdSchema, IsoDateTimeSchema } from './common.ts';

// ── Account ────────────────────────────────────────────────────────────────

export const SYNC_STATUSES = ['idle', 'syncing', 'error'] as const;
export const SyncStatusSchema = z.enum(SYNC_STATUSES);

/** A mail account as the UI sees it. No host, port, username or secret — ever. */
export const AccountSchema = z.strictObject({
  id: IdSchema,
  email: z.string().min(1).max(320),
  /** `''` when the user set none. */
  displayName: z.string().max(200),
  /**
   * Does the provider keep custom keywords (labels) on the server? `false` = labels are local to Kaydet;
   * `null` = not known yet. (mobile `Accounts.supportsKeywords`)
   */
  supportsServerLabels: z.boolean().nullable(),
  sync: z.strictObject({
    status: SyncStatusSchema,
    lastSyncAt: IsoDateTimeSchema.nullable(),
  }),
});
export type AccountDTO = z.infer<typeof AccountSchema>;

// ── Folder ─────────────────────────────────────────────────────────────────

export const FolderRoleSchema = z.enum(FOLDER_ROLES);

/** A folder, in display (tree) order. The path is server-internal; hierarchy is `parentId`/`depth`. */
export const FolderSchema = z.strictObject({
  id: IdSchema,
  accountId: IdSchema,
  /** Turkish display name (`Gelen Kutusu`, …) for system folders, the user's name for custom ones. */
  name: z.string().min(1).max(255),
  role: FolderRoleSchema,
  /** Nearest visible ancestor; `null` for roots. */
  parentId: IdSchema.nullable(),
  /** 0 = root. */
  depth: z.number().int().min(0),
  hasChildren: z.boolean(),
  /** "Sık Kullanılanlar" — a local preference, distinct from pinned messages. */
  isFavorite: z.boolean(),
  unreadCount: z.number().int().min(0),
  totalCount: z.number().int().min(0),
});
export type FolderDTO = z.infer<typeof FolderSchema>;

// ── Label ──────────────────────────────────────────────────────────────────

export const LabelSchema = z.strictObject({
  id: IdSchema,
  accountId: IdSchema,
  /** Unique per account. Messages reference labels by this name. */
  name: z.string().min(1).max(100),
  /** Index into the shared 15-tone palette. */
  tone: z.number().int().min(0).max(TONE_COUNT - 1),
});
export type LabelDTO = z.infer<typeof LabelSchema>;

// ── Attachment ─────────────────────────────────────────────────────────────

/** Attachment metadata. `id` is not the MIME part id; download goes through the attachment endpoint. */
export const AttachmentSchema = z.strictObject({
  id: IdSchema,
  /** The message (or draft) that owns it. */
  messageId: IdSchema,
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().min(0),
  isInline: z.boolean(),
});
export type AttachmentDTO = z.infer<typeof AttachmentSchema>;

// ── Message ────────────────────────────────────────────────────────────────

export const OUTBOX_STATES = ['none', 'queued', 'sending', 'failed', 'sent'] as const;
export const OutboxStateSchema = z.enum(OUTBOX_STATES);
export type OutboxState = z.infer<typeof OutboxStateSchema>;

/** One list row. */
export const MessageSummarySchema = z.strictObject({
  id: IdSchema,
  accountId: IdSchema,
  folderId: IdSchema,
  /** Opaque conversation id (local threading result). */
  threadId: IdSchema,
  from: EmailAddressSchema,
  to: z.array(EmailAddressSchema),
  subject: z.string().max(2000),
  /** Server-generated (`buildPreview`): quotes and signature skipped. */
  preview: z.string().max(400),
  date: IsoDateTimeSchema,
  seen: z.boolean(),
  /** IMAP `\Flagged`, shown as "Sabitle". */
  pinned: z.boolean(),
  answered: z.boolean(),
  forwarded: z.boolean(),
  draft: z.boolean(),
  hasAttachments: z.boolean(),
  /** Present when `draft` is true: the draft to open for editing (a draft's id is NOT its message id, D8). */
  draftId: IdSchema.optional(),
  /** Label names. */
  labels: z.array(z.string().min(1).max(100)),
  outbox: z.strictObject({
    state: OutboxStateSchema,
    /** User-safe text (never provider output). */
    error: z.string().max(500).optional(),
  }),
});
export type MessageSummaryDTO = z.infer<typeof MessageSummarySchema>;

/**
 * Body of a message — the end of the trust pipeline (decision D2):
 *
 *   provider/IMAP -> raw, UNTRUSTED HTML -> SERVER-SIDE sanitisation -> sanitised HTML -> this DTO -> web reader
 *   -> sandboxed rendering
 *
 * Raw provider HTML is never part of any DTO. The server sanitises (allow-list; no scripts, handlers, refresh
 * metas; cid images rewritten to attachment URLs) and `sanitized: true` is a literal, so an unsanitised body
 * cannot be typed as this DTO. The browser is NEVER responsible for making raw mail HTML trustworthy; it
 * only receives sanitised content and STILL renders it inside a sandboxed iframe with a restrictive CSP
 * (defence in depth, not a licence to inject). The sanitiser itself is server-phase work.
 */
export const MessageBodySchema = z.strictObject({
  text: z.string().nullable(),
  html: z.strictObject({ content: z.string(), sanitized: z.literal(true) }).nullable(),
});
export type MessageBodyDTO = z.infer<typeof MessageBodySchema>;

/** A message opened in the reader. */
export const MessageSchema = MessageSummarySchema.extend({
  cc: z.array(EmailAddressSchema),
  /** Only ever non-empty on the user's own outgoing mail. */
  bcc: z.array(EmailAddressSchema),
  body: MessageBodySchema,
  attachments: z.array(AttachmentSchema),
});
export type MessageDTO = z.infer<typeof MessageSchema>;

// ── Draft / outbox ─────────────────────────────────────────────────────────

export const REPLY_MODES = ['reply', 'replyAll', 'forward'] as const;
export const ReplyModeSchema = z.enum(REPLY_MODES);

/** The message a draft answers. The server derives `In-Reply-To`/`References` from it. */
export const DraftSourceSchema = z.strictObject({ messageId: IdSchema, mode: ReplyModeSchema });
export type DraftSourceDTO = z.infer<typeof DraftSourceSchema>;

/**
 * Autosave payload. Recipients are lenient here (a draft may hold half-typed input); the server validates
 * them when the draft is SENT. `bodyText` is what the user typed; `bodyHtml` the editor's rich-text output
 * (user-authored outgoing HTML, not sanitised mail).
 */
export const DraftInputSchema = z.strictObject({
  accountId: IdSchema,
  to: z.array(EmailAddressSchema).max(500),
  cc: z.array(EmailAddressSchema).max(500),
  bcc: z.array(EmailAddressSchema).max(500),
  subject: z.string().max(2000),
  bodyText: z.string().max(5_000_000),
  bodyHtml: z.string().max(10_000_000).nullable(),
  attachmentIds: z.array(IdSchema).max(100),
  source: DraftSourceSchema.nullable(),
});
export type DraftInputDTO = z.infer<typeof DraftInputSchema>;

export const DraftSchema = z.strictObject({
  /** Draft identifier (client-generated on first save). Distinct from any message id and from the outbox id. */
  id: IdSchema,
  accountId: IdSchema,
  to: z.array(EmailAddressSchema),
  cc: z.array(EmailAddressSchema),
  bcc: z.array(EmailAddressSchema),
  subject: z.string(),
  bodyText: z.string(),
  bodyHtml: z.string().nullable(),
  attachments: z.array(AttachmentSchema),
  source: DraftSourceSchema.nullable(),
  /** The Drafts-folder message that represents this draft in lists, once it exists; `null` before that. */
  messageId: IdSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
});
export type DraftDTO = z.infer<typeof DraftSchema>;

/**
 * A send operation (decision D8). Three DISTINCT opaque ids, none assumed equal to another:
 *
 *   Draft (`draftId`) -> send requested -> Outbox operation (`id` = outboxId) -> SMTP -> Message (`messageId`)
 *
 * A draft exists without any outbox operation; an outbox operation has its own lifecycle (queued -> sending ->
 * sent | failed, cancellable until `cancellableUntil`) and points back to the draft it was created from.
 * `messageId` is the resulting message once it exists (typically in Sent); `null` until then.
 */
export const OutboxSchema = z.strictObject({
  /** The outbox id: what `POST /outbox/:outboxId/cancel` takes. */
  id: IdSchema,
  accountId: IdSchema,
  draftId: IdSchema,
  messageId: IdSchema.nullable(),
  state: OutboxStateSchema,
  cancellableUntil: IsoDateTimeSchema.nullable(),
  /** User-safe failure text when `state` is `failed`. */
  error: z.string().max(500).nullable(),
});
export type OutboxDTO = z.infer<typeof OutboxSchema>;

// ── Search ─────────────────────────────────────────────────────────────────

/** A mail hit: the row plus the folder it sits in (results show the folder name). */
export const SearchResultSchema = z.strictObject({
  message: MessageSummarySchema,
  folder: z.strictObject({ id: IdSchema, name: z.string().min(1).max(255), role: FolderRoleSchema }),
});
export type SearchResultDTO = z.infer<typeof SearchResultSchema>;

// ── Signature / template ───────────────────────────────────────────────────

export const SignatureSchema = z.strictObject({
  id: IdSchema,
  accountId: IdSchema,
  name: z.string().min(1).max(100),
  body: z.string().max(20_000),
  /** At most one per account; the compose window inserts it automatically. */
  isDefault: z.boolean(),
});
export type SignatureDTO = z.infer<typeof SignatureSchema>;

/** Quick reply text (mobile `QuickTemplate`). `isBuiltIn` is only a badge; built-ins can be edited/deleted. */
export const TemplateSchema = z.strictObject({
  id: IdSchema,
  title: z.string().min(1).max(100),
  content: z.string().max(20_000),
  isBuiltIn: z.boolean(),
});
export type TemplateDTO = z.infer<typeof TemplateSchema>;

// ── Session ────────────────────────────────────────────────────────────────

/**
 * State of the Kaydet web session (decision D1). The session belongs to a Kaydet user and OWNS the mail
 * accounts under it: account ids are only meaningful inside their session, and another user's account answers
 * `account_not_found` (never `forbidden`, so existence is not revealed). No mail credentials, no tokens.
 * A session with zero accounts is normal (the client then offers "add account"); expiry ends every account
 * view at once (`session_expired`, event `session.ended`).
 */
export const SessionSchema = z.strictObject({
  authenticated: z.boolean(),
  /** Opaque Kaydet user id; `null` when signed out. */
  user: z.strictObject({ id: IdSchema }).nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
});
export type SessionDTO = z.infer<typeof SessionSchema>;

// ── Pages ──────────────────────────────────────────────────────────────────

/** Where a message list page comes from. Echoed in every page so the client can verify it. */
export const MessageScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('folder'), folderId: IdSchema }),
  /** The virtual "Sabitlenenler" view: pinned messages of every folder of the account. */
  z.strictObject({ kind: z.literal('pinned') }),
]);
export type MessageScope = z.infer<typeof MessageScopeSchema>;

export const MessagePageSchema = z.strictObject({
  accountId: IdSchema,
  scope: MessageScopeSchema,
  items: z.array(MessageSummarySchema),
  /** `null` = end of the list. */
  nextCursor: CursorSchema.nullable(),
});
export type MessagePageDTO = z.infer<typeof MessagePageSchema>;

export const SearchPageSchema = z.strictObject({
  items: z.array(SearchResultSchema),
  nextCursor: CursorSchema.nullable(),
});
export type SearchPageDTO = z.infer<typeof SearchPageSchema>;

/** Collection responses are objects with `items`, so they can grow fields without breaking clients. */
export const listOf = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item) });

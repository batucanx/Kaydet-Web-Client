/**
 * Query-string schemas (GET parameters).
 *
 * Each schema PARSES the flat, string-only wire form into a structured value and has an `encode…` twin that
 * writes the wire form back, so client and server cannot drift.
 *
 * Scoping is explicit and cannot be mixed up:
 *  - a message list is always `accountId` (path) + exactly one scope: a folder id OR the pinned view;
 *  - a folder id is only meaningful together with its account: the server answers 404/409 when the folder
 *    does not belong to the account in the path, and every page echoes `accountId` + `scope`;
 *  - the cursor is bound to (account, scope, filter, sort) by the server (`invalid_cursor` otherwise);
 *  - `messageListKey` gives caches one key per (account, scope, filter), and `pageMatchesRequest` lets the
 *    client discard a late response that belongs to a previous folder/account.
 */
import { z } from 'zod';
import { FOLDER_ROLES } from '../folder/index.ts';
import { MESSAGE_SORTS } from '../message/index.ts';
import type { MessageFilter } from '../message/index.ts';
import type { SearchFilters } from '../search/index.ts';
import { CursorSchema, DEFAULT_PAGE_SIZE, IdSchema, IsoDateTimeSchema, PageLimitSchema, QueryBooleanSchema, encodeQuery } from './common.ts';
import type { DateRange } from './common.ts';
import type { MessagePageDTO, MessageScope } from './dto.ts';

// ── Message list ───────────────────────────────────────────────────────────

/** Structured form of a message-list request (the account travels in the path). */
export interface MessageListParams {
  readonly scope: MessageScope;
  readonly filter: MessageFilter;
  readonly cursor: string | null;
  readonly limit: number;
}

export const MessageListQuerySchema = z
  .strictObject({
    scope: z.enum(['folder', 'pinned']),
    folderId: IdSchema.optional(),
    unread: QueryBooleanSchema.default(false),
    pinned: QueryBooleanSchema.default(false),
    attachments: QueryBooleanSchema.default(false),
    label: z.string().min(1).max(100).optional(),
    sort: z.enum(MESSAGE_SORTS).default('dateDesc'),
    cursor: CursorSchema.optional(),
    limit: PageLimitSchema,
  })
  .superRefine((q, ctx) => {
    if (q.scope === 'folder' && q.folderId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['folderId'], message: '`folderId` is required for scope=folder' });
    }
    if (q.scope === 'pinned' && q.folderId !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['folderId'], message: '`folderId` must not be combined with scope=pinned' });
    }
  })
  .transform((q): MessageListParams => ({
    scope: q.scope === 'pinned' ? { kind: 'pinned' } : { kind: 'folder', folderId: q.folderId as string },
    filter: { unread: q.unread, pinned: q.pinned, attachments: q.attachments, label: q.label ?? null, sort: q.sort },
    cursor: q.cursor ?? null,
    limit: q.limit,
  }));

/** Wire form of a message-list request. Defaults are omitted, so the URL of an unfiltered list is short. */
export function encodeMessageListQuery(params: {
  scope: MessageScope;
  filter?: MessageFilter;
  cursor?: string | null;
  limit?: number;
}): Record<string, string> {
  const f = params.filter;
  return encodeQuery({
    scope: params.scope.kind,
    folderId: params.scope.kind === 'folder' ? params.scope.folderId : undefined,
    unread: f?.unread ? true : undefined,
    pinned: f?.pinned ? true : undefined,
    attachments: f?.attachments ? true : undefined,
    label: f?.label ?? undefined,
    sort: f && f.sort !== 'dateDesc' ? f.sort : undefined,
    cursor: params.cursor ?? undefined,
    limit: params.limit !== undefined && params.limit !== DEFAULT_PAGE_SIZE ? params.limit : undefined,
  });
}

/**
 * Cache key for a list: one per (account, scope, filter). Cursor and limit are NOT part of it (they address a
 * position inside the same list). Two different folders or accounts can never share a key.
 */
export function messageListKey(accountId: string, scope: MessageScope, filter: MessageFilter): string {
  return JSON.stringify([
    'messages',
    accountId,
    scope.kind === 'folder' ? ['folder', scope.folderId] : ['pinned'],
    [filter.unread, filter.pinned, filter.attachments, filter.label, filter.sort],
  ]);
}

/** Does a received page answer THIS request? A `false` means: drop it (late response of another list). */
export function pageMatchesRequest(page: Pick<MessagePageDTO, 'accountId' | 'scope'>, request: { accountId: string; scope: MessageScope }): boolean {
  if (page.accountId !== request.accountId) return false;
  if (page.scope.kind !== request.scope.kind) return false;
  return page.scope.kind === 'pinned' || (request.scope.kind === 'folder' && page.scope.folderId === request.scope.folderId);
}

// ── Search ─────────────────────────────────────────────────────────────────

export type SearchAccountScope = { readonly kind: 'all' } | { readonly kind: 'account'; readonly accountId: string };

export interface SearchParams {
  readonly q: string;
  readonly accounts: SearchAccountScope;
  readonly filters: SearchFilters;
  /** Web extension (mobile has no date filter); `null` = any time. */
  readonly dateRange: DateRange | null;
  readonly cursor: string | null;
  readonly limit: number;
}

export const SearchQuerySchema = z
  .strictObject({
    q: z.string().trim().min(1).max(200),
    /** Explicit: "all accounts" is a choice, never the result of forgetting `accountId`. */
    accounts: z.enum(['all', 'account']),
    accountId: IdSchema.optional(),
    attachments: QueryBooleanSchema.default(false),
    includeDeleted: QueryBooleanSchema.default(false),
    /** Folder scope by role; custom folders additionally need `folderName`. Omitted = all folders. */
    folderRole: z.enum(FOLDER_ROLES).optional(),
    folderName: z.string().min(1).max(255).optional(),
    after: IsoDateTimeSchema.optional(),
    before: IsoDateTimeSchema.optional(),
    cursor: CursorSchema.optional(),
    limit: PageLimitSchema,
  })
  .superRefine((q, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (q.accounts === 'account' && q.accountId === undefined) issue('accountId', '`accountId` is required for accounts=account');
    if (q.accounts === 'all' && q.accountId !== undefined) issue('accountId', '`accountId` must not be combined with accounts=all');
    if (q.folderRole === 'custom' && q.folderName === undefined) issue('folderName', '`folderName` is required for a custom folder');
    if (q.folderRole !== 'custom' && q.folderName !== undefined) issue('folderName', '`folderName` is only valid with folderRole=custom');
    if (q.after !== undefined && q.before !== undefined && Date.parse(q.after) >= Date.parse(q.before)) {
      issue('after', '`after` must be earlier than `before`');
    }
  })
  .transform((q): SearchParams => {
    const folder: SearchFilters['folder'] =
      q.folderRole === undefined
        ? null
        : q.folderRole === 'custom'
          ? { role: 'custom', name: q.folderName as string }
          : { role: q.folderRole };
    const dateRange: DateRange | null =
      q.after === undefined && q.before === undefined
        ? null
        : {
            ...(q.after !== undefined ? { after: q.after } : {}),
            ...(q.before !== undefined ? { before: q.before } : {}),
          };
    return {
      q: q.q,
      accounts: q.accounts === 'all' ? { kind: 'all' } : { kind: 'account', accountId: q.accountId as string },
      filters: { attachmentsOnly: q.attachments, includeDeleted: q.includeDeleted, folder },
      dateRange,
      cursor: q.cursor ?? null,
      limit: q.limit,
    };
  });

export function encodeSearchQuery(params: {
  q: string;
  accounts: SearchAccountScope;
  filters?: SearchFilters;
  dateRange?: DateRange | null;
  cursor?: string | null;
  limit?: number;
}): Record<string, string> {
  const f = params.filters;
  return encodeQuery({
    q: params.q,
    accounts: params.accounts.kind,
    accountId: params.accounts.kind === 'account' ? params.accounts.accountId : undefined,
    attachments: f?.attachmentsOnly ? true : undefined,
    includeDeleted: f?.includeDeleted ? true : undefined,
    folderRole: f?.folder?.role,
    folderName: f?.folder?.name,
    after: params.dateRange?.after,
    before: params.dateRange?.before,
    cursor: params.cursor ?? undefined,
    limit: params.limit !== undefined && params.limit !== DEFAULT_PAGE_SIZE ? params.limit : undefined,
  });
}

// ── Attachment download ────────────────────────────────────────────────────

export const AttachmentDownloadQuerySchema = z.strictObject({
  /**
   * `true` forces `Content-Disposition: attachment`. The server also forces it for executables and for
   * source-like types (HTML/SVG/XML) regardless of this flag, and always sends `X-Content-Type-Options: nosniff`.
   */
  download: QueryBooleanSchema.default(false),
});

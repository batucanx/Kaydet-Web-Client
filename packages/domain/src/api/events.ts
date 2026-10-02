/**
 * Server-sent events (`GET /events`).
 *
 * Events are INVALIDATION HINTS, not data: they say which account/folder/draft changed and the client
 * refetches through the normal endpoints. That keeps one source of truth (the REST responses), makes missed
 * events harmless (a reconnect just triggers a refresh of what is on screen) and means an event can never
 * carry a message body or credentials.
 *
 * Wire format: standard SSE. `event:` = `type`, `data:` = the JSON of the event (schema below), `id:` = a
 * server-issued opaque id the browser echoes as `Last-Event-ID` on reconnect. Events are scoped to the
 * signed-in session; the stream has no query parameters.
 */
import { z } from 'zod';
import { ApiErrorSchema } from './errors.ts';
import { IdSchema, IsoDateTimeSchema } from './common.ts';
import { OutboxStateSchema, SyncStatusSchema } from './dto.ts';

export const MailEventSchema = z.discriminatedUnion('type', [
  /** Sync of an account started / finished / failed. `error` is present when `status` is `error`. */
  z.strictObject({
    type: z.literal('sync.status'),
    accountId: IdSchema,
    status: SyncStatusSchema,
    lastSyncAt: IsoDateTimeSchema.nullable(),
    error: ApiErrorSchema.nullable(),
  }),
  /** The folder list of an account changed (created/renamed/moved/deleted, or counters changed). */
  z.strictObject({ type: z.literal('folders.changed'), accountId: IdSchema }),
  /** Messages in these folders changed (new mail, flags from another client, moves, deletions). */
  z.strictObject({
    type: z.literal('messages.changed'),
    accountId: IdSchema,
    folderIds: z.array(IdSchema).min(1).max(200),
  }),
  /** A send changed state (queued → sending → sent | failed). */
  z.strictObject({
    type: z.literal('outbox.changed'),
    accountId: IdSchema,
    outboxId: IdSchema,
    draftId: IdSchema,
    state: OutboxStateSchema,
  }),
  /** The account list changed (added/updated/removed, possibly from another tab). */
  z.strictObject({ type: z.literal('accounts.changed') }),
  /** The session ended; the client must sign in again. The server closes the stream right after. */
  z.strictObject({ type: z.literal('session.ended') }),
]);
export type MailEvent = z.infer<typeof MailEventSchema>;
export type MailEventType = MailEvent['type'];

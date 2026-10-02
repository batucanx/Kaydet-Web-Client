/**
 * Shared primitives of the API contract.
 *
 * The API contract (this folder) is the SINGLE source of truth between browser and server: DTO shapes,
 * request/response bodies and query strings are defined once as Zod schemas, and the TypeScript types are
 * inferred from them. apps/web and apps/server must import these — never re-declare a DTO.
 *
 * Browser-safe by construction: every object schema is `strictObject`, so a payload carrying an unexpected
 * key (an IMAP UID, a raw flag list, a password…) fails validation instead of silently leaking through.
 */
import { z } from 'zod';

/**
 * Opaque identifier. The browser only stores and echoes ids; it must not parse or construct them. They are
 * application ids, never IMAP UIDs/paths.
 */
export const IdSchema = z.string().min(1).max(256);
export type Id = z.infer<typeof IdSchema>;

/** ISO-8601 instant in UTC (`2026-09-30T12:00:00.000Z`). */
export const IsoDateTimeSchema = z.iso.datetime();
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/**
 * Address as received in mail: lenient about the mailbox (real mail contains malformed addresses).
 * `name` is `''` when the sender gave none (mobile treats null and blank the same).
 */
export const EmailAddressSchema = z.strictObject({
  email: z.string().min(1).max(320),
  name: z.string().max(998),
});
export type EmailAddressDTO = z.infer<typeof EmailAddressSchema>;

/**
 * Opaque pagination cursor. Server-issued, bound to (account, scope, filter, sort): the server rejects a cursor
 * used with a different query (`invalid_cursor`), so rows of a previous folder can never be appended to the
 * current one.
 */
export const CursorSchema = z.string().min(1).max(2048);

export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;

/** Query-string boolean: only the literal words `true`/`false` (what `encodeQuery` writes). */
export const QueryBooleanSchema = z.stringbool({ truthy: ['true'], falsy: ['false'] });

/** Page size as it arrives in a query string. */
export const PageLimitSchema = z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE);

/** Half-open time window; both bounds optional, `after` must precede `before`. */
export const DateRangeSchema = z
  .strictObject({ after: IsoDateTimeSchema.optional(), before: IsoDateTimeSchema.optional() })
  .refine((r) => r.after === undefined || r.before === undefined || Date.parse(r.after) < Date.parse(r.before), {
    message: '`after` must be earlier than `before`',
  });
export type DateRange = z.infer<typeof DateRangeSchema>;

/**
 * Serialises a flat query object for a URL. `undefined`/`null` are dropped, booleans and numbers written as
 * text; nothing is guessed about arrays (the contract has none).
 */
export function encodeQuery(query: Record<string, string | number | boolean | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

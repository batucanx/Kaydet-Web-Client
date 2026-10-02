/**
 * Cursor pagination, shared by every list (message list, search; later SQLite, FTS, IMAP-backed sources).
 *
 * The browser sees only the contract's opaque `cursor`. Behind it, a repository/source speaks in a `position`
 * string of its own choosing (a keyset of the local store, say) — never an IMAP UID/UIDVALIDITY/MODSEQ, which
 * are not allowed to reach the browser.
 *
 *   browser cursor ──decode──▶ position ──▶ repository ──▶ nextPosition ──encode──▶ browser cursor
 *
 * The cursor is bound to a `binding` (account + scope + filter + sort, from the domain's `messageListKey`, or the
 * search parameters): a cursor replayed against a different query is `invalid_cursor` (contract), so rows of one
 * folder can never be appended to another. The cursor is NOT signed — a repository must treat the position it
 * receives as untrusted input and validate it (signing arrives with the secrets of the auth phase).
 */
import { AppError } from './errors.ts';

export interface PageRequest {
  /** `null` = first page. Opaque to everything except the repository that issued it. */
  readonly position: string | null;
  readonly limit: number;
}

export interface RepositoryPage<T> {
  readonly items: readonly T[];
  /** `null` = end of the list. */
  readonly nextPosition: string | null;
}

export interface CursorPage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

const VERSION = 1;
const MAX_CURSOR_LENGTH = 2048;

/** FNV-1a (32 bit): a cheap deterministic fingerprint. Consistency check, not security. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function encodeCursor(binding: string, position: string): string {
  const cursor = toBase64Url(JSON.stringify({ v: VERSION, b: fingerprint(binding), p: position }));
  if (cursor.length > MAX_CURSOR_LENGTH) throw new Error('pagination position too large for a cursor');
  return cursor;
}

/** Position carried by `cursor`, or `invalid_cursor` when it is malformed or was issued for another query. */
export function decodeCursor(binding: string, cursor: string): string {
  const invalid = () => new AppError('invalid_cursor');
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(cursor));
    if (typeof parsed !== 'object' || parsed === null) throw invalid();
    const { v, b, p } = parsed as Record<string, unknown>;
    if (v !== VERSION || b !== fingerprint(binding) || typeof p !== 'string') throw invalid();
    return p;
  } catch (error) {
    throw error instanceof AppError ? error : invalid();
  }
}

/** Contract request (`cursor`, `limit`) → what a repository receives. */
export function toPageRequest(binding: string, cursor: string | null, limit: number): PageRequest {
  return { position: cursor === null ? null : decodeCursor(binding, cursor), limit };
}

/** Repository page → contract page (`items`, `nextCursor`). */
export function toCursorPage<T>(binding: string, page: RepositoryPage<T>): CursorPage<T> {
  return { items: [...page.items], nextCursor: page.nextPosition === null ? null : encodeCursor(binding, page.nextPosition) };
}

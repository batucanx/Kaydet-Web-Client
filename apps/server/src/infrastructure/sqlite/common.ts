/** Small helpers shared by the SQLite repositories. */
import { DatabaseError } from './database.ts';
import type { SqlValue } from './database.ts';

/**
 * Timestamps are stored as ISO-8601 UTC text with milliseconds (`2026-09-30T12:00:00.000Z`): the same representation the
 * API contract uses, fixed width so that string order equals time order (indexes and keyset pagination rely on it), and
 * independent of SQLite's date functions and of the machine's time zone.
 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const toIso = (date: Date): string => date.toISOString();

export function fromIso(text: string): Date {
  if (!ISO_UTC.test(text)) throw new DatabaseError('stored timestamp is not ISO-8601 UTC');
  return new Date(text);
}
export const fromIsoOrNull = (text: unknown): Date | null => (text === null || text === undefined ? null : fromIso(String(text)));

export const isIso = (text: string): boolean => ISO_UTC.test(text);

export const bit = (value: boolean): 0 | 1 => (value ? 1 : 0);
export const flag = (value: unknown): boolean => value === 1 || value === 1n;
export const text = (value: unknown): string => String(value);
export const textOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
export const int = (value: unknown): number => Number(value);
export const intOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** `IN (?, ?, …)` placeholder list and the values, chunked to stay far below SQLite's variable limit. */
export function chunks<T>(items: readonly T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
export const placeholders = (count: number): string => Array.from({ length: count }, () => '?').join(', ');

export type Params = SqlValue[];

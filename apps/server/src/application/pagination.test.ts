import { describe, expect, it } from 'vitest';
import { AppError } from './errors.ts';
import { decodeCursor, encodeCursor, toCursorPage, toPageRequest } from './pagination.ts';

const binding = JSON.stringify(['messages', 'acc', ['folder', 'inbox']]);

describe('cursor pagination', () => {
  it('round-trips a repository position through an opaque cursor', () => {
    const cursor = encodeCursor(binding, 'position with ünïcode / and + symbols');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe
    expect(decodeCursor(binding, cursor)).toBe('position with ünïcode / and + symbols');
  });

  it('does not expose the position or the binding in readable form', () => {
    const cursor = encodeCursor(binding, '42');
    expect(cursor).not.toContain('42');
    expect(cursor).not.toContain('inbox');
  });

  it('rejects a cursor issued for a different query (folder, account, filter or sort)', () => {
    const cursor = encodeCursor(binding, '10');
    for (const other of [JSON.stringify(['messages', 'acc', ['folder', 'trash']]), JSON.stringify(['messages', 'other', ['folder', 'inbox']])]) {
      expect(() => decodeCursor(other, cursor)).toThrow(AppError);
      expect(() => decodeCursor(other, cursor)).toThrowError(expect.objectContaining({ code: 'invalid_cursor' }));
    }
  });

  it('rejects garbage, truncated and wrongly-typed cursors as invalid_cursor', () => {
    const good = encodeCursor(binding, '1');
    const wrongType = btoa(JSON.stringify({ v: 1, b: 'x', p: 5 }));
    for (const bad of ['not base64 !!', good.slice(0, 6), btoa('null'), btoa('[]'), wrongType, '%%%']) {
      expect(() => decodeCursor(binding, bad), bad).toThrowError(expect.objectContaining({ code: 'invalid_cursor' }));
    }
  });

  it('maps the contract request to a page request and a repository page to the contract page', () => {
    expect(toPageRequest(binding, null, 30)).toEqual({ position: null, limit: 30 });
    const page = toCursorPage(binding, { items: ['a', 'b'], nextPosition: '2' });
    expect(page.items).toEqual(['a', 'b']);
    expect(toPageRequest(binding, page.nextCursor, 30).position).toBe('2');
    expect(toCursorPage(binding, { items: [], nextPosition: null }).nextCursor).toBeNull();
  });
});

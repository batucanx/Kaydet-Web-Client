import { describe, expect, it } from 'vitest';
import { avatarToneIndex, fnv1a32 } from './avatar';
import { formatGroupHeader, formatListDate } from './dates';
import { avatarInitial, trLower, trUpper } from './turkish';

// Reference "now": Wednesday 2026-09-30 15:00 local.
const now = new Date(2026, 8, 30, 15, 0);
const at = (y: number, m: number, d: number, h = 14, min = 23) => new Date(y, m - 1, d, h, min);

describe('formatListDate (mobile parity)', () => {
  it('today → time', () => expect(formatListDate(at(2026, 9, 30), now)).toBe('14:23'));
  it('yesterday', () => expect(formatListDate(at(2026, 9, 29), now)).toBe('Dün 14:23'));
  it('2–6 days → weekday', () => expect(formatListDate(at(2026, 9, 27), now)).toBe('Paz 14:23'));
  it('this year → day + month', () => expect(formatListDate(at(2026, 8, 14), now)).toBe('14 Ağu'));
  it('older year → dd.mm.yy', () => expect(formatListDate(at(2025, 9, 14), now)).toBe('14.09.25'));
});

describe('formatGroupHeader (mobile parity)', () => {
  it('buckets', () => {
    expect(formatGroupHeader(at(2026, 9, 30), now)).toBe('Bugün');
    expect(formatGroupHeader(at(2026, 9, 29), now)).toBe('Dün');
    expect(formatGroupHeader(at(2026, 9, 26), now)).toBe('Geçen Hafta');
    expect(formatGroupHeader(at(2026, 9, 10), now)).toBe('Bu Ay');
    expect(formatGroupHeader(at(2026, 7, 4), now)).toBe('Temmuz 2026');
  });
  it('future-dated messages stay in Bugün', () => {
    expect(formatGroupHeader(at(2026, 10, 3), now)).toBe('Bugün');
  });
});

describe('avatar hash (FNV-1a 32)', () => {
  it('matches known vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
  });
  it('is stable, case-insensitive on address, and in range', () => {
    const a = avatarToneIndex('Ali@Sirket.com', 'Ali', 15);
    expect(a).toBe(avatarToneIndex('ali@sirket.com', 'x', 15));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(15);
  });
  it('falls back to the name, then to 0', () => {
    expect(avatarToneIndex('', 'Ayşe', 15)).toBe(fnv1a32('ayşe') % 15);
    expect(avatarToneIndex('', '', 15)).toBe(0);
  });
});

describe('Turkish casing', () => {
  it('handles dotted/dotless i', () => {
    expect(trUpper('ısı')).toBe('ISI');
    expect(trUpper('istanbul')).toBe('İSTANBUL');
    expect(trLower('IŞIK')).toBe('ışık');
    expect(trLower('İSMAİL')).toBe('ismail');
  });
  it('avatar initial uses Turkish upper-casing', () => {
    expect(avatarInitial('ismail şahin', null)).toBe('İ');
    expect(avatarInitial('', 'çelik@x.com')).toBe('Ç');
    expect(avatarInitial('  ', '')).toBe('?');
    expect(avatarInitial('“” 42', null)).toBe('4');
  });
});

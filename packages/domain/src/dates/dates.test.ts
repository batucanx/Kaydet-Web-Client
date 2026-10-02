import { describe, expect, it } from 'vitest';
import { formatDetailDate, formatGroupHeader, formatListDate, formatRelative } from './dates.ts';

// Local-time constructors: the functions render in the runtime zone, like mobile `toLocal()`.
const at = (y: number, m: number, d: number, h = 14, min = 23) => new Date(y, m - 1, d, h, min);

describe('formatListDate (mobile text_and_models_test.dart)', () => {
  const now = at(2026, 9, 14, 15, 0); // Monday

  it('today → time', () => expect(formatListDate(at(2026, 9, 14, 13, 54), now)).toBe('13:54'));
  it('yesterday', () => expect(formatListDate(at(2026, 9, 13, 10, 0), now)).toBe('Dün 10:00'));
  it('2–6 days → Turkish weekday', () => expect(formatListDate(at(2026, 9, 10, 10, 0), now)).toBe('Per 10:00'));
  it('English locale → English weekday / Yesterday', () => {
    expect(formatListDate(at(2026, 9, 10, 10, 0), now, 'en')).toBe('Thu 10:00');
    expect(formatListDate(at(2026, 9, 13, 10, 0), now, 'en-US')).toBe('Yesterday 10:00');
  });
  it('7+ days in the same year → day + month', () => {
    expect(formatListDate(at(2026, 3, 5, 10, 0), now)).toBe('5 Mar');
    expect(formatListDate(at(2026, 9, 7, 10, 0), now)).toBe('7 Eyl');
  });
  it('older year → dd.mm.yy', () => expect(formatListDate(at(2025, 3, 5, 10, 0), now)).toBe('05.03.25'));

  it('calendar-day comparison follows midnight and month/year rollover', () => {
    expect(formatListDate(at(2025, 12, 31, 23, 59), at(2026, 1, 1, 0, 1))).toBe('Dün 23:59');
    expect(formatListDate(at(2026, 9, 14, 23, 59), at(2026, 9, 15, 0, 1))).toBe('Dün 23:59');
  });

  it('a future-dated message falls through to the date branch (mobile behaviour)', () => {
    expect(formatListDate(at(2026, 9, 15, 9, 5), now)).toBe('15 Eyl');
  });
});

describe('formatGroupHeader (mobile)', () => {
  const now = at(2026, 9, 30, 15, 0);

  it('buckets', () => {
    expect(formatGroupHeader(at(2026, 9, 30), now)).toBe('Bugün');
    expect(formatGroupHeader(at(2026, 9, 29), now)).toBe('Dün');
    expect(formatGroupHeader(at(2026, 9, 26), now)).toBe('Geçen Hafta');
    expect(formatGroupHeader(at(2026, 9, 10), now)).toBe('Bu Ay');
    expect(formatGroupHeader(at(2026, 7, 4), now)).toBe('Temmuz 2026');
  });

  it('boundaries: 6 days → Geçen Hafta, 7 → Bu Ay, 29 → Bu Ay, 30 → month name', () => {
    expect(formatGroupHeader(at(2026, 9, 24), now)).toBe('Geçen Hafta');
    expect(formatGroupHeader(at(2026, 9, 23), now)).toBe('Bu Ay');
    expect(formatGroupHeader(at(2026, 9, 1), now)).toBe('Bu Ay');
    expect(formatGroupHeader(at(2026, 8, 31), now)).toBe('Ağustos 2026');
  });

  it('future-dated messages stay in Bugün', () => {
    expect(formatGroupHeader(at(2026, 10, 3), now)).toBe('Bugün');
  });
});

describe('formatDetailDate', () => {
  it('uses Turkish month and weekday names', () => {
    expect(formatDetailDate(at(2026, 9, 14, 13, 54))).toBe('14 Eylül 2026 Pazartesi, 13:54');
    expect(formatDetailDate(at(2026, 1, 4, 7, 5))).toBe('4 Ocak 2026 Pazar, 07:05');
  });
});

describe('formatRelative', () => {
  const now = at(2026, 9, 14, 15, 0);
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;

  it('az önce under 45 seconds and for the future', () => {
    expect(formatRelative(ago(10 * SEC), now)).toBe('az önce');
    expect(formatRelative(ago(44 * SEC), now)).toBe('az önce');
    expect(formatRelative(new Date(now.getTime() + MIN), now)).toBe('az önce');
  });
  it('minutes, hours, days', () => {
    // Mobile quirk, preserved: 45–59 s is past the 'az önce' threshold but under one minute.
    expect(formatRelative(ago(45 * SEC), now)).toBe('0 dk önce');
    expect(formatRelative(ago(5 * MIN), now)).toBe('5 dk önce');
    expect(formatRelative(ago(3 * HOUR), now)).toBe('3 sa önce');
    expect(formatRelative(ago(3 * 24 * HOUR), now)).toBe('3 gün önce');
  });
  it('30+ days falls back to the list date', () => {
    expect(formatRelative(ago(40 * 24 * HOUR), now)).toBe(formatListDate(ago(40 * 24 * HOUR), now));
  });
});

/**
 * Date formatting for lists, detail view and group headers.
 *
 * SOURCE: mobile `lib/core/date_format.dart` (`formatListDate`, `formatDetailDate`, `formatGroupHeader`,
 *         `formatRelative`).
 * PURPOSE: Deterministic Turkish month/day names (no Intl/ICU dependency, so output is identical in every
 *          runtime and unit-testable) and the exact bucketing rules the mobile list uses. Calendar-day
 *          differences ignore DST (a 23/25-hour day cannot change a bucket).
 * WEB USAGE: list rows (`formatListDate`), date group headers, message detail header, "az önce" style text.
 *
 * All functions take absolute instants (`Date`) and render them in the runtime's local time zone, which is
 * what mobile does (`toLocal()`). The browser therefore shows the user's own zone; DTO dates are ISO UTC.
 */

const MONTHS_SHORT = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'] as const;
const MONTHS_LONG = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
] as const;
/** Index 0 = Monday (mobile `DateTime.weekday - 1`). */
const WEEKDAYS_SHORT = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'] as const;
const WEEKDAYS_SHORT_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const WEEKDAYS_LONG = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'] as const;

const two = (n: number): string => String(n).padStart(2, '0');
/** JS `getDay()` is 0 = Sunday; mobile weekday index is 0 = Monday. */
const weekdayIndex = (d: Date): number => (d.getDay() + 6) % 7;

/** Calendar-day difference, immune to DST (mobile `_calendarDayDifference`). */
function calendarDayDifference(later: Date, earlier: Date): number {
  const a = Date.UTC(later.getFullYear(), later.getMonth(), later.getDate());
  const b = Date.UTC(earlier.getFullYear(), earlier.getMonth(), earlier.getDate());
  return Math.round((a - b) / 86_400_000);
}

/**
 * Short date for a list row.
 * Today `14:23` · yesterday `Dün 14:23` · previous 2–6 calendar days `Pzt 14:23` · this year `14 Eyl` ·
 * older `14.09.25`.
 */
export function formatListDate(date: Date, now: Date = new Date(), locale = 'tr'): string {
  const english = locale.toLowerCase().startsWith('en');
  const diffDays = calendarDayDifference(now, date);
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;

  if (diffDays === 0) return time;
  if (diffDays === 1) return `${english ? 'Yesterday' : 'Dün'} ${time}`;
  if (diffDays > 1 && diffDays < 7) {
    const weekdays = english ? WEEKDAYS_SHORT_EN : WEEKDAYS_SHORT;
    return `${weekdays[weekdayIndex(date)]} ${time}`;
  }
  if (date.getFullYear() === now.getFullYear()) return `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}`;
  return `${two(date.getDate())}.${two(date.getMonth() + 1)}.${two(date.getFullYear() % 100)}`;
}

/** Long date for the message detail: `14 Eylül 2026 Pazartesi, 13:54`. */
export function formatDetailDate(date: Date): string {
  return (
    `${date.getDate()} ${MONTHS_LONG[date.getMonth()]} ${date.getFullYear()} ` +
    `${WEEKDAYS_LONG[weekdayIndex(date)]}, ${two(date.getHours())}:${two(date.getMinutes())}`
  );
}

/** List group header: `Bugün`, `Dün`, `Geçen Hafta`, `Bu Ay`, `Eylül 2026`. Future dates stay in `Bugün`. */
export function formatGroupHeader(date: Date, now: Date = new Date()): string {
  const diffDays = calendarDayDifference(now, date);
  // A message dated in the future (sender's clock, bad `Date` header) sorts to the top of the list, so its
  // header must be "Bugün" as well — a negative difference used to land under "Geçen Hafta".
  if (diffDays <= 0) return 'Bugün';
  if (diffDays === 1) return 'Dün';
  if (diffDays < 7) return 'Geçen Hafta';
  if (diffDays < 30) return 'Bu Ay';
  return `${MONTHS_LONG[date.getMonth()]} ${date.getFullYear()}`;
}

/** Relative time: `az önce`, `5 dk önce`, `2 sa önce`, `3 gün önce`, then the list date. */
export function formatRelative(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const seconds = Math.trunc(diffMs / 1000);
  if (diffMs < 0 || seconds < 45) return 'az önce';
  const minutes = Math.trunc(seconds / 60);
  if (minutes < 60) return `${minutes} dk önce`;
  const hours = Math.trunc(minutes / 60);
  if (hours < 24) return `${hours} sa önce`;
  const days = Math.trunc(hours / 24);
  if (days < 30) return `${days} gün önce`;
  return formatListDate(date, now);
}

/**
 * List date formatting and grouping. The rules live in `@kaydet/domain` (ported from mobile
 * `lib/core/date_format.dart`); this module keeps the web's import path stable and adds the one
 * web-only formatter (tooltip text).
 */
export { formatGroupHeader, formatListDate } from '@kaydet/domain';

const MONTHS_LONG = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
];

const two = (n: number): string => String(n).padStart(2, '0');

/** Full timestamp for tooltips: `14 Eylül 2026, 13:54`. */
export function formatFullDate(date: Date): string {
  return `${date.getDate()} ${MONTHS_LONG[date.getMonth()]} ${date.getFullYear()}, ${two(date.getHours())}:${two(date.getMinutes())}`;
}

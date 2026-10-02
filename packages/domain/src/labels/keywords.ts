/**
 * Label ↔ mail-server keyword mapping.
 *
 * SOURCE: mobile `lib/domain/use_cases/label_keywords.dart` (`labelImapKeyword`, `uniqueLabelKeyword`) and the
 *         tone palette size used by labels/avatars.
 * PURPOSE: IMAP keywords cannot contain spaces or Turkish letters, so a label name is folded to ASCII, every
 *          non-alphanumeric character becomes `_`, and the result is prefixed `kaydet_`. The keyword is stored
 *          with the label and is what sync reads back to turn a server keyword into the visible label name —
 *          it MUST stay compatible with the mobile app so labels applied on a phone show up on the web and
 *          vice versa. Different names can fold to the same ASCII ("Kişisel"/"Kisisel", "A B"/"A-B"), which
 *          would make two labels toggle each other, so keywords are made unique per account.
 * WEB USAGE: server only (label create, label apply/remove, sync). The browser never sees keywords; it works
 *            with label ids/names.
 */
import { foldForSearch } from '../turkish/index.ts';

/** Size of the shared colour palette that label tones and avatar tones index into. */
export const TONE_COUNT = 15;

/** Server keyword for a label name, e.g. `Kişisel` → `kaydet_kisisel`. */
export function labelKeyword(name: string): string {
  return `kaydet_${foldForSearch(name).replace(/[^a-z0-9]/g, '_')}`;
}

/** {@link labelKeyword} made unique among the account's `taken` keywords (`_2`, `_3`, … on collision). */
export function uniqueLabelKeyword(name: string, taken: Iterable<string>): string {
  const base = labelKeyword(name);
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix++;
  return `${base}_${suffix}`;
}

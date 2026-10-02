/**
 * Draft / reply / reply-all / forward semantics.
 *
 * SOURCE: mobile `lib/ui/features/compose/compose_screen.dart` → `_applyReply`, `_prefixSubject`,
 *         `ComposeMode`; header rules from `lib/domain/use_cases/threading.dart` (`buildReferences`);
 *         answered/forwarded marking from `MailRepository._markSourceMessage`.
 * PURPOSE: What a new compose window starts with, per mode:
 *          - reply:    To = sender, subject `Yanıt: …`, body = signature + "<date> tarihinde <ad> <adres>
 *                      yazdı:" + quoted text.
 *          - replyAll: same, Cc = everyone else on the original (To + Cc) minus me and minus the sender.
 *          - forward:  subject `İlet: …`, body = signature + "---------- İletilen ileti ----------" header
 *                      block + original text; no recipients, and NO reply headers.
 *          A subject that already carries a reply/forward prefix is not prefixed again. Reply headers
 *          (`In-Reply-To`, `References`) are what lets the recipient's client thread the answer.
 * WEB USAGE: compose UI prefill (the web keeps the same wording/format as mobile) and the server when it
 *            builds the outgoing message for a draft that references a source message.
 */
import { addressDisplay, formatAddress, sameAddress } from '../address/index.ts';
import type { AddressLike } from '../address/index.ts';
import { formatDetailDate } from '../dates/index.ts';
import { htmlToPlain, quoteText } from '../message/index.ts';
import { buildReferences } from '../threading/index.ts';
import { foldForSearch } from '../turkish/index.ts';

export const COMPOSE_MODES = ['new', 'reply', 'replyAll', 'forward'] as const;
/** mobile: `ComposeMode` (`newMessage` → `new`). */
export type ComposeMode = (typeof COMPOSE_MODES)[number];

/** The modes that answer a source message (they carry a source reference). */
export type SourceComposeMode = Exclude<ComposeMode, 'new'>;

export const REPLY_SUBJECT_PREFIX = 'Yanıt';
export const FORWARD_SUBJECT_PREFIX = 'İlet';

/** Prefixes that mean "already a reply/forward" (folded). Mobile's list, verbatim (note: no `fw:`). */
const ALREADY_PREFIXED = ['re:', 'yanit:', 'fwd:', 'ilet:'] as const;

/**
 * `Yanıt: konu` / `İlet: konu`, unless the subject already starts with a reply/forward prefix (then it is
 * returned trimmed). Detection folds the text first: mobile lower-cased with the default (non-Turkish)
 * casing, so `İlet:` and `YANIT:` slipped through and got a second prefix — the fold closes that gap.
 */
export function prefixSubject(subject: string, prefix: typeof REPLY_SUBJECT_PREFIX | typeof FORWARD_SUBJECT_PREFIX): string {
  const trimmed = subject.trim();
  const folded = foldForSearch(trimmed);
  if (ALREADY_PREFIXED.some((p) => folded.startsWith(p))) return trimmed;
  return `${prefix}: ${trimmed}`;
}

/** The parts of the original message a reply/forward needs. */
export interface ComposeSource {
  readonly from: AddressLike;
  readonly to: readonly AddressLike[];
  readonly cc: readonly AddressLike[];
  readonly subject: string;
  readonly date: Date;
  readonly bodyText: string | null;
  readonly bodyHtml: string | null;
}

export interface ComposeStart {
  readonly to: Array<{ email: string; name: string }>;
  readonly cc: Array<{ email: string; name: string }>;
  readonly subject: string;
  readonly bodyText: string;
}

const plain = (a: AddressLike): { email: string; name: string } => ({ email: a.email, name: a.name ?? '' });

/**
 * Starting content of a compose window. `selfEmail` is the sending account (removed from reply-all
 * recipients); `signature` is the default signature text, prepended as-is.
 */
export function buildComposeStart(input: {
  mode: ComposeMode;
  source: ComposeSource | null;
  selfEmail: string | null;
  signature?: string;
}): ComposeStart {
  const signature = input.signature ?? '';
  const { mode, source, selfEmail } = input;
  if (mode === 'new' || source === null) return { to: [], cc: [], subject: '', bodyText: signature };

  const from = plain(source.from);
  const quotedSource = source.bodyText ?? (source.bodyHtml !== null ? htmlToPlain(source.bodyHtml) : '');
  const quoteHeader = `\n\n${formatDetailDate(source.date)} tarihinde ${addressDisplay(from)} <${from.email}> yazdı:\n`;
  const replyBody = `${signature}${quoteHeader}${quoteText(quotedSource)}`;

  switch (mode) {
    case 'reply':
      return { to: [from], cc: [], subject: prefixSubject(source.subject, REPLY_SUBJECT_PREFIX), bodyText: replyBody };

    case 'replyAll': {
      // My own address and the sender (already in To) are not repeated. Duplicates between To and Cc of the
      // original are kept, as on mobile.
      const others = [...source.to, ...source.cc]
        .filter((a) => selfEmail === null || !sameAddress(a, { email: selfEmail }))
        .filter((a) => !sameAddress(a, from))
        .map(plain);
      return {
        to: [from],
        cc: others,
        subject: prefixSubject(source.subject, REPLY_SUBJECT_PREFIX),
        bodyText: replyBody,
      };
    }

    case 'forward':
      return {
        to: [],
        cc: [],
        subject: prefixSubject(source.subject, FORWARD_SUBJECT_PREFIX),
        bodyText:
          `${signature}\n\n` +
          '---------- İletilen ileti ----------\n' +
          `Kimden: ${formatAddress(from)}\n` +
          `Tarih: ${formatDetailDate(source.date)}\n` +
          `Konu: ${source.subject}\n` +
          `Kime: ${source.to.map(formatAddress).join(', ')}\n\n` +
          quotedSource,
      };
  }
}

/**
 * `In-Reply-To` / `References` for an outgoing reply or reply-all; `null` for forward and new mail (a forward
 * starts its own conversation). Built server-side from the source's headers, which never reach the browser.
 */
export function buildReplyHeaders(input: {
  mode: ComposeMode;
  originalMessageId: string | null;
  originalReferences: string | null;
}): { inReplyTo: string | null; references: string } | null {
  if (input.mode !== 'reply' && input.mode !== 'replyAll') return null;
  return {
    inReplyTo: input.originalMessageId,
    references: buildReferences({
      originalReferences: input.originalReferences,
      originalMessageId: input.originalMessageId,
    }),
  };
}

/** Which flag the SOURCE message gets when the reply/forward is sent (marked immediately, optimistically). */
export function sourceMarkOnSend(mode: ComposeMode): 'answered' | 'forwarded' | null {
  if (mode === 'reply' || mode === 'replyAll') return 'answered';
  if (mode === 'forward') return 'forwarded';
  return null;
}

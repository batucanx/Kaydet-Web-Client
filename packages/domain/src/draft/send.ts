/**
 * Pre-send checks and the forgotten-attachment reminder.
 *
 * SOURCE: mobile `lib/ui/features/compose/compose_screen.dart` → `_send` (order of checks, wording) and
 *         `lib/ui/features/compose/attachment_reminder.dart` (`AttachmentReminder`; tests:
 *         `test/attachment_reminder_test.dart`); undo-send window from `sendUndoWindowProvider` (5 s) in
 *         `lib/app/providers.dart`.
 * PURPOSE: Blocking errors first (at least one To recipient; every To/Cc/Bcc address syntactically valid),
 *          then two CONFIRMATIONS the user can override, in this order: the text mentions an attachment but
 *          none is attached; the subject is empty. The reminder is Turkish/English keyword based, matched on
 *          word boundaries so "ekim", "ekip", "ekran", "ekmek", "teşekkür" do NOT trigger it, and in a
 *          reply/forward only the user's NEW text counts (not the quoted original).
 * WEB USAGE: the compose UI before "Gönder"; the server repeats the blocking checks on
 *            `POST /drafts/:id/send` (never trust the client).
 */
import { isValidEmail } from '../address/index.ts';
import type { AddressLike } from '../address/index.ts';
import { trLower } from '../turkish/index.ts';

/** How long a sent message can still be pulled back before the server hands it to SMTP. */
export const UNDO_SEND_WINDOW_MS = 5000;

const KEYWORD =
  /(?:^|[\s\p{P}])(ek(?:te|tedir|teki|teydi|tedirler|lerin|leri)?|ekli(?:dir)?|ekledim|ekliyorum|eklemiştim|ekledik|ekliyoruz|ilişik(?:te|tedir|teki)?|attach(?:ed|ment|ments|ing)?|enclos(?:ed|ing|ure)?)(?:$|[\s\p{P}])/u;

/** Marks where quoted history starts, so it can be cut away. */
const QUOTE_HEADER = /(?:tarihinde .* yazdı:|---------- İletilen ileti ----------|Original Message|From:)/i;

/** Does the text say something is attached? */
export function mentionsAttachment(text: string): boolean {
  if (text.trim() === '') return false;
  // Turkish I/İ casing has to be right for "İlişik…" / "EKTE".
  return KEYWORD.test(trLower(text));
}

/** The text the user typed in a reply/forward, without `>` quotes and everything after a quote header. */
export function extractUserTypedBody(fullBody: string): string {
  const kept: string[] = [];
  for (const line of fullBody.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('>')) continue; // standard quote line
    if (QUOTE_HEADER.test(trimmed)) break; // the rest is the old message
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/** Should we warn that an attachment was probably forgotten? */
export function shouldWarnAboutMissingAttachment(input: {
  subject: string;
  body: string;
  hasAttachments: boolean;
  isReplyOrForward?: boolean;
}): boolean {
  if (input.hasAttachments) return false;
  if (mentionsAttachment(input.subject)) return true;
  const text = input.isReplyOrForward === true ? extractUserTypedBody(input.body) : input.body;
  return mentionsAttachment(text);
}

export type SendBlocker =
  | { readonly code: 'no_recipients' }
  | { readonly code: 'invalid_address'; readonly address: string };

export type SendConfirmation = 'missing_attachment' | 'empty_subject';

export interface SendCheck {
  /** When set, sending is not possible until it is fixed. */
  readonly blocker: SendBlocker | null;
  /** Ask in this order; each can be dismissed by the user. Empty when blocked. */
  readonly confirmations: readonly SendConfirmation[];
}

/** User-facing texts of the blockers (mobile `_send`). */
export function describeSendBlocker(blocker: SendBlocker): string {
  return blocker.code === 'no_recipients' ? 'En az bir alıcı girin.' : `Geçersiz adres: ${blocker.address}`;
}

export function checkBeforeSend(input: {
  to: readonly AddressLike[];
  cc: readonly AddressLike[];
  bcc: readonly AddressLike[];
  subject: string;
  bodyText: string;
  hasAttachments: boolean;
  isReplyOrForward: boolean;
}): SendCheck {
  if (input.to.length === 0) return { blocker: { code: 'no_recipients' }, confirmations: [] };
  const invalid = [...input.to, ...input.cc, ...input.bcc].find((a) => !isValidEmail(a.email));
  if (invalid) return { blocker: { code: 'invalid_address', address: invalid.email }, confirmations: [] };

  const confirmations: SendConfirmation[] = [];
  if (
    shouldWarnAboutMissingAttachment({
      subject: input.subject,
      body: input.bodyText,
      hasAttachments: input.hasAttachments,
      isReplyOrForward: input.isReplyOrForward,
    })
  ) {
    confirmations.push('missing_attachment');
  }
  if (input.subject.trim() === '') confirmations.push('empty_subject');
  return { blocker: null, confirmations };
}

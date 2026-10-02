/**
 * Conversation (thread) grouping.
 *
 * SOURCE: mobile `lib/domain/use_cases/threading.dart` (`Threading`, `ThreadInput`; tests:
 *         `test/threading_test.dart`, the References group of `test/text_and_models_test.dart`).
 * PURPOSE: Plain IMAP gives no conversation groups (THREAD is not universal and not stable), so grouping is
 *          local: `References` / `In-Reply-To` are the primary source, and when there are no headers the
 *          normalised subject is the fallback. A simplified JWZ. Mail with neither headers nor a subject is
 *          its own conversation — otherwise every subject-less automated mail would pile into one giant
 *          thread.
 * WEB USAGE: server-side sync (assign `threadId`), reply header construction (`buildReferences`).
 *            The browser only ever sees the resulting opaque `threadId`.
 */
import { foldForSearch, normalizeSubject } from '../turkish/index.ts';

/** Ids of `<abc@host>` form; some servers omit the angle brackets. */
export function parseReferences(raw: string | null | undefined): string[] {
  if (raw == null || raw.trim() === '') return [];
  const bracketed = [...raw.matchAll(/<([^<>]+)>/g)].map((m) => (m[1] as string).trim());
  if (bracketed.length > 0) return bracketed;
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && s.includes('@'));
}

/** Normalises a single Message-ID (strips brackets); `null` when empty. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const match = /<([^<>]+)>/.exec(trimmed);
  const id = (match?.[1] ?? trimmed).trim();
  return id === '' ? null : id;
}

/**
 * Subject-based fallback key. An empty (after normalisation) subject yields `null`: grouping mail that has
 * no subject would be an unwanted result.
 */
export function subjectThreadKey(subject: string | null | undefined): string | null {
  const normalized = normalizeSubject(subject);
  if (normalized === '') return null;
  return `subj:${foldForSearch(normalized)}`;
}

export interface ThreadHeaders {
  readonly messageId: string | null | undefined;
  readonly inReplyTo: string | null | undefined;
  readonly references: string | null | undefined;
  readonly subject: string | null | undefined;
}

/** A source of ids that cannot collide; injected so the function stays deterministic in tests. */
export type FallbackIdGenerator = () => string;

let fallbackCounter = 0;
const defaultFallbackId: FallbackIdGenerator = () => `single:${Date.now()}:${fallbackCounter++}`;

/**
 * Thread id for one message. `knownThreads` maps `messageId → threadId` computed earlier; a message whose
 * ancestor is known joins that conversation.
 */
export function resolveThreadId(
  input: ThreadHeaders & { knownThreads: ReadonlyMap<string, string> },
  fallbackId: FallbackIdGenerator = defaultFallbackId,
): string {
  const inReplyTo = normalizeMessageId(input.inReplyTo);
  const refs = [...parseReferences(input.references), ...(inReplyTo !== null ? [inReplyTo] : [])];

  // 1. An ancestor belongs to a known conversation (nearest ancestor first): join it.
  for (let i = refs.length - 1; i >= 0; i--) {
    const existing = input.knownThreads.get(refs[i] as string);
    if (existing !== undefined) return existing;
  }
  // 2. Unknown ancestors: the root becomes the conversation id.
  if (refs.length > 0) return refs[0] as string;
  // 3. Its own Message-ID: this message is the root of the conversation.
  const own = normalizeMessageId(input.messageId);
  if (own !== null) return own;
  // 4. Last resort: the subject key; without a subject the message stands alone.
  return subjectThreadKey(input.subject) ?? fallbackId();
}

/**
 * `References` for a reply: old References + the original's Message-ID (RFC 5322). A broken chain makes the
 * recipient's client split the conversation. Deduplicated; capped at 20 (first + last 19) because very long
 * chains exceed header limits on some servers.
 */
export function buildReferences(input: {
  originalReferences: string | null | undefined;
  originalMessageId: string | null | undefined;
}): string {
  const parts: string[] = [];
  const { originalReferences, originalMessageId } = input;
  if (originalReferences != null && originalReferences.trim() !== '') {
    parts.push(...(originalReferences.match(/<[^<>]+>/g) ?? []));
  }
  if (originalMessageId != null && originalMessageId.trim() !== '') {
    let id = originalMessageId.trim();
    if (id.startsWith('<')) id = id.slice(1);
    if (id.endsWith('>')) id = id.slice(0, -1);
    const bracketed = `<${id}>`;
    if (!parts.includes(bracketed)) parts.push(bracketed);
  }
  if (parts.length > 20) return [parts[0] as string, ...parts.slice(parts.length - 19)].join(' ');
  return parts.join(' ');
}

export interface ThreadInput extends ThreadHeaders {
  /** Caller's key for the message (result map key). */
  readonly id: string;
}

/**
 * Thread assignment for a batch. `items` MUST be ordered by date, oldest first, so ancestors are processed
 * before their children.
 */
export function assignThreads(
  items: readonly ThreadInput[],
  options: { fallbackId?: FallbackIdGenerator } = {},
): Map<string, string> {
  const byMessageId = new Map<string, string>();
  const bySubject = new Map<string, string>();
  const result = new Map<string, string>();

  for (const item of items) {
    const threadId = resolveThreadId({ ...item, knownThreads: byMessageId }, options.fallbackId);
    let finalThread = threadId;

    // No header information at all: try to merge by subject.
    const hasHeaders =
      (item.messageId != null && item.messageId !== '') ||
      (item.references != null && item.references !== '') ||
      (item.inReplyTo != null && item.inReplyTo !== '');
    const subjectKey = subjectThreadKey(item.subject);
    if (!hasHeaders && subjectKey !== null) finalThread = bySubject.get(subjectKey) ?? threadId;

    const own = normalizeMessageId(item.messageId);
    if (own !== null) byMessageId.set(own, finalThread);
    if (subjectKey !== null && !bySubject.has(subjectKey)) bySubject.set(subjectKey, finalThread);

    result.set(item.id, finalThread);
  }
  return result;
}

import type { AttachmentDTO, DraftDTO, EmailAddressDTO, OutboxDTO, OutboxState } from '@kaydet/domain';
import type { ClaimedOutboxItem, Clock, DraftRepository, OutboxRepository, OutboxRetryState } from '../../application/index.ts';
import { bit, flag, fromIso, fromIsoOrNull, int, text, textOrNull, toIso } from './common.ts';
import { DatabaseError } from './database.ts';
import type { SqliteDatabase } from './database.ts';

type Kind = 'to' | 'cc' | 'bcc';

/**
 * Drafts, keyed by (user, client-generated id) so two users' ids never collide. A draft is stored with its recipients (in
 * order) and its attachment METADATA; `save` replaces all of it in one transaction. Removing a draft removes those rows and
 * any outbox rows created from it, and never touches the Drafts-folder message it points to (that link is SET NULL).
 */
export class SqliteDraftRepository implements DraftRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  async find(userId: string, draftId: string): Promise<DraftDTO | null> {
    const d = await this.db.get(
      `SELECT id, account_id, subject, body_text, body_html, source_message_id, source_mode, message_id, updated_at
       FROM drafts WHERE user_id = ? AND id = ?`,
      [userId, draftId],
    );
    if (d === undefined) return null;
    const [recipients, attachments] = await Promise.all([
      this.db.all('SELECT kind, email, name FROM draft_recipients WHERE user_id = ? AND draft_id = ? ORDER BY kind, position', [userId, draftId]),
      this.db.all('SELECT id, file_name, mime_type, size_bytes, is_inline FROM attachments WHERE draft_user_id = ? AND draft_id = ? ORDER BY created_at, rowid', [userId, draftId]),
    ]);
    const of = (kind: Kind): EmailAddressDTO[] => recipients.filter((r) => r['kind'] === kind).map((r) => ({ email: text(r['email']), name: text(r['name']) }));
    const sourceMessageId = textOrNull(d['source_message_id']);
    return {
      id: text(d['id']),
      accountId: text(d['account_id']),
      to: of('to'),
      cc: of('cc'),
      bcc: of('bcc'),
      subject: text(d['subject']),
      bodyText: text(d['body_text']),
      bodyHtml: textOrNull(d['body_html']),
      // For a draft's attachment, the DTO's `messageId` is the draft id (the contract: "the message (or draft) that owns it").
      attachments: attachments.map((a): AttachmentDTO => ({ id: text(a['id']), messageId: draftId, fileName: text(a['file_name']), mimeType: text(a['mime_type']), sizeBytes: int(a['size_bytes']), isInline: flag(a['is_inline']) })),
      source: sourceMessageId === null ? null : { messageId: sourceMessageId, mode: text(d['source_mode']) as 'reply' | 'replyAll' | 'forward' },
      messageId: textOrNull(d['message_id']),
      updatedAt: fromIso(text(d['updated_at'])).toISOString(),
    };
  }

  async save(userId: string, draft: DraftDTO): Promise<void> {
    const updatedAt = new Date(draft.updatedAt).toISOString();
    await this.db.transaction(async () => {
      await this.db.run(
        `INSERT INTO drafts (user_id, id, account_id, subject, body_text, body_html, source_message_id, source_mode, message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, id) DO UPDATE SET account_id = excluded.account_id, subject = excluded.subject, body_text = excluded.body_text,
           body_html = excluded.body_html, source_message_id = excluded.source_message_id, source_mode = excluded.source_mode,
           message_id = excluded.message_id, updated_at = excluded.updated_at`,
        [userId, draft.id, draft.accountId, draft.subject, draft.bodyText, draft.bodyHtml, draft.source?.messageId ?? null, draft.source?.mode ?? null, draft.messageId, toIso(this.clock.now()), updatedAt],
      );

      await this.db.run('DELETE FROM draft_recipients WHERE user_id = ? AND draft_id = ?', [userId, draft.id]);
      for (const [kind, list] of [['to', draft.to], ['cc', draft.cc], ['bcc', draft.bcc]] as const) {
        for (const [position, a] of list.entries()) {
          await this.db.run('INSERT INTO draft_recipients (user_id, draft_id, kind, position, email, name) VALUES (?, ?, ?, ?, ?, ?)', [userId, draft.id, kind, position, a.email, a.name]);
        }
      }

      // Attachment metadata: keep the listed ones, drop the rest of THIS draft's.
      const keep = draft.attachments.map((a) => a.id);
      const existing = await this.db.all('SELECT id FROM attachments WHERE draft_user_id = ? AND draft_id = ?', [userId, draft.id]);
      for (const row of existing) {
        if (!keep.includes(text(row['id']))) await this.db.run('DELETE FROM attachments WHERE id = ?', [text(row['id'])]);
      }
      for (const a of draft.attachments) {
        const { changes } = await this.db.run(
          `INSERT INTO attachments (id, draft_user_id, draft_id, file_name, mime_type, size_bytes, is_inline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET file_name = excluded.file_name, mime_type = excluded.mime_type, size_bytes = excluded.size_bytes, is_inline = excluded.is_inline
           WHERE attachments.draft_user_id = excluded.draft_user_id AND attachments.draft_id = excluded.draft_id`,
          [a.id, userId, draft.id, a.fileName, a.mimeType, a.sizeBytes, bit(a.isInline), toIso(this.clock.now())],
        );
        if (changes === 0) throw new DatabaseError('attachment id belongs to another owner');
      }
    });
  }

  async remove(userId: string, draftId: string): Promise<void> {
    await this.db.run('DELETE FROM drafts WHERE user_id = ? AND id = ?', [userId, draftId]);
  }
}

type OutboxRow = Record<string, unknown>;
const OUTBOX_COLUMNS = 'id, account_id, draft_id, message_id, state, cancellable_until, error';
const toOutbox = (r: OutboxRow): OutboxDTO => ({
  id: text(r['id']),
  accountId: text(r['account_id']),
  draftId: text(r['draft_id']),
  messageId: textOrNull(r['message_id']),
  state: text(r['state']) as OutboxState,
  cancellableUntil: fromIsoOrNull(r['cancellable_until'])?.toISOString() ?? null,
  error: textOrNull(r['error']),
});

/**
 * Send operations (storage only — the worker that drives them is a later phase). The database limits `state` to
 * queued | sending | failed | sent; who may move an item from which state to which is the application's rule (DATABASE.md
 * "Outbox state machine"), not a trigger. A row exists only while a send exists: cancelling removes it.
 */
export class SqliteOutboxRepository implements OutboxRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  async find(userId: string, outboxId: string): Promise<OutboxDTO | null> {
    const r = await this.db.get(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE user_id = ? AND id = ?`, [userId, outboxId]);
    return r === undefined ? null : toOutbox(r);
  }

  async findByDraft(userId: string, draftId: string): Promise<OutboxDTO | null> {
    const r = await this.db.get(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE user_id = ? AND draft_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, [userId, draftId]);
    return r === undefined ? null : toOutbox(r);
  }

  async save(userId: string, outbox: OutboxDTO): Promise<void> {
    if (outbox.state === 'none') throw new DatabaseError('"none" is not a stored outbox state');
    const now = toIso(this.clock.now());
    await this.db.run(
      `INSERT INTO outbox (id, user_id, account_id, draft_user_id, draft_id, message_id, state, cancellable_until, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET message_id = excluded.message_id, state = excluded.state, cancellable_until = excluded.cancellable_until,
         error = excluded.error, updated_at = excluded.updated_at
       WHERE outbox.user_id = excluded.user_id`,
      [outbox.id, userId, outbox.accountId, userId, outbox.draftId, outbox.messageId, outbox.state, outbox.cancellableUntil === null ? null : new Date(outbox.cancellableUntil).toISOString(), outbox.error, now, now],
    );
  }

  async remove(userId: string, outboxId: string): Promise<void> {
    await this.db.run('DELETE FROM outbox WHERE user_id = ? AND id = ?', [userId, outboxId]);
  }

  async retryState(userId: string, outboxId: string): Promise<OutboxRetryState | null> {
    const r = await this.db.get('SELECT attempt_count, next_attempt_at FROM outbox WHERE user_id = ? AND id = ?', [userId, outboxId]);
    return r === undefined ? null : { attemptCount: int(r['attempt_count']), nextAttemptAt: fromIsoOrNull(r['next_attempt_at']) };
  }

  async setRetryState(userId: string, outboxId: string, state: OutboxRetryState): Promise<void> {
    await this.db.run('UPDATE outbox SET attempt_count = ?, next_attempt_at = ?, updated_at = ? WHERE user_id = ? AND id = ?', [
      state.attemptCount,
      state.nextAttemptAt === null ? null : toIso(state.nextAttemptAt),
      toIso(this.clock.now()),
      userId,
      outboxId,
    ]);
  }

  async claimNextDue(workerToken: string, leaseDurationMs: number, now: Date): Promise<ClaimedOutboxItem | null> {
    const nowIso = toIso(now);
    const leaseExpiresIso = toIso(new Date(now.getTime() + leaseDurationMs));

    return await this.db.transaction(async () => {
      const candidate = await this.db.get(
        `SELECT id, user_id, account_id, draft_id, attempt_count
         FROM outbox
         WHERE (state = 'queued' AND (cancellable_until IS NULL OR cancellable_until <= ?))
            OR (state = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
            OR (state = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
         ORDER BY updated_at ASC, rowid ASC LIMIT 1`,
        [nowIso, nowIso, nowIso],
      );

      if (candidate === undefined) return null;

      const outboxId = text(candidate['id']);
      const userId = text(candidate['user_id']);
      const accountId = text(candidate['account_id']);
      const draftId = text(candidate['draft_id']);
      const attemptCount = int(candidate['attempt_count']);

      const { changes } = await this.db.run(
        `UPDATE outbox
         SET state = 'sending',
             lease_token = ?,
             lease_expires_at = ?,
             updated_at = ?
         WHERE id = ? AND (
           (state = 'queued' AND (cancellable_until IS NULL OR cancellable_until <= ?))
           OR (state = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
           OR (state = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
         )`,
        [workerToken, leaseExpiresIso, nowIso, outboxId, nowIso, nowIso, nowIso],
      );

      if (changes === 0) return null;

      return {
        outboxId,
        userId,
        accountId,
        draftId,
        attemptCount,
      };
    });
  }

  async completeSend(userId: string, outboxId: string, messageId: string | null, now: Date): Promise<void> {
    const nowIso = toIso(now);
    await this.db.run(
      `UPDATE outbox
       SET state = 'sent',
           message_id = ?,
           lease_token = NULL,
           lease_expires_at = NULL,
           error = NULL,
           updated_at = ?
       WHERE user_id = ? AND id = ?`,
      [messageId, nowIso, userId, outboxId],
    );
  }

  async failAttempt(userId: string, outboxId: string, error: string, retryDelayMs: number | null, now: Date): Promise<void> {
    const nowIso = toIso(now);
    const nextAttemptAtIso = retryDelayMs !== null ? toIso(new Date(now.getTime() + retryDelayMs)) : null;

    await this.db.run(
      `UPDATE outbox
       SET state = 'failed',
           attempt_count = attempt_count + 1,
           next_attempt_at = ?,
           lease_token = NULL,
           lease_expires_at = NULL,
           error = ?,
           updated_at = ?
       WHERE user_id = ? AND id = ?`,
      [nextAttemptAtIso, error, nowIso, userId, outboxId],
    );
  }

  async recoverStaleLeases(now: Date): Promise<number> {
    const nowIso = toIso(now);
    const { changes } = await this.db.run(
      `UPDATE outbox
       SET state = 'queued',
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = ?
       WHERE state = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      [nowIso, nowIso],
    );
    return changes;
  }
}

import { foldForSearch, trLower } from '@kaydet/domain';
import type { AuthorizedAccount, Clock } from '../../application/index.ts';
import type { MailStoreWriter, ProviderFolderRef, ProviderMessageRef, StoredFolder, StoredMessage } from '../../application/ports/repositories/mail-store.ts';
import { bit, flag, int, intOrNull, placeholders, text, textOrNull, toIso } from './common.ts';
import { DatabaseError } from './database.ts';
import type { SqliteDatabase } from './database.ts';

const SORT_KEY_LENGTH = 200; // keeps keyset cursors well inside the contract's cursor size limit

/**
 * The write side of the local mail mirror (see the port for the provider-identity rules). Every multi-row write runs in a
 * transaction — its own if the caller has none, the caller's if it has (they nest), so a whole sync batch can be made atomic
 * by wrapping several calls in `UnitOfWork.run`.
 *
 * Search index: `messages_fts` has no foreign keys, so THIS class keeps it in step with `messages` inside the same
 * transaction (insert/update → replace the row; delete → remove it). The indexed text is the domain's `foldForSearch` of
 * subject, sender name, sender address, preview and plain-text body — nothing is normalised in SQL.
 */
export class SqliteMailStore implements MailStoreWriter {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  async upsertFolder(account: AuthorizedAccount, folder: StoredFolder): Promise<void> {
    const now = toIso(this.clock.now());
    const p = folder.provider;
    // `is_favorite` is a local preference: absent from the update unless the caller supplies it.
    const favoriteUpdate = folder.isFavorite === undefined ? '' : ', is_favorite = excluded.is_favorite';
    const { changes } = await this.db.run(
      `INSERT INTO folders (id, account_id, name, role, provider_path, provider_delimiter, sort_order, is_favorite,
                            provider_uid_validity, provider_uid_next, provider_highest_modseq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, role = excluded.role, provider_path = excluded.provider_path,
         provider_delimiter = excluded.provider_delimiter, sort_order = excluded.sort_order,
         provider_uid_validity = excluded.provider_uid_validity, provider_uid_next = excluded.provider_uid_next,
         provider_highest_modseq = excluded.provider_highest_modseq, updated_at = excluded.updated_at${favoriteUpdate}
       WHERE folders.account_id = excluded.account_id`,
      [folder.id, account.id, folder.name, folder.role, p.path, p.delimiter, folder.sortOrder, bit(folder.isFavorite ?? false), p.uidValidity, p.uidNext, p.highestModSeq, now, now],
    );
    if (changes === 0) throw new DatabaseError('folder id belongs to another account');
  }

  async removeFolder(account: AuthorizedAccount, folderId: string): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.run(
        'DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE folder_id = ? AND account_id = ?)',
        [folderId, account.id],
      );
      await this.db.run('DELETE FROM messages WHERE folder_id = ? AND account_id = ?', [folderId, account.id]);
      await this.db.run('DELETE FROM folders WHERE id = ? AND account_id = ?', [folderId, account.id]);
    });
  }

  async upsertMessage(account: AuthorizedAccount, stored: StoredMessage): Promise<void> {
    const { message, provider } = stored;
    if (message.accountId !== account.id) throw new DatabaseError('message belongs to another account');
    if (message.attachments.some((a) => a.messageId !== message.id)) throw new DatabaseError('attachment does not belong to the message');

    await this.db.transaction(async () => {
      const folder = await this.db.get('SELECT 1 AS ok FROM folders WHERE id = ? AND account_id = ?', [message.folderId, account.id]);
      if (folder === undefined) throw new DatabaseError('folder does not belong to the account');

      // Labels are referenced by name and must already exist for the account.
      const labelIds: string[] = [];
      if (message.labels.length > 0) {
        const known = await this.db.all(`SELECT id, name FROM labels WHERE account_id = ? AND name IN (${placeholders(message.labels.length)})`, [account.id, ...message.labels]);
        const byName = new Map(known.map((l) => [text(l['name']), text(l['id'])]));
        for (const name of new Set(message.labels)) {
          const id = byName.get(name);
          if (id === undefined) throw new DatabaseError('message references a label that does not exist');
          labelIds.push(id);
        }
      }

      const now = toIso(this.clock.now());
      const sender = message.from.name !== '' ? message.from.name : message.from.email;
      const { changes } = await this.db.run(
        `INSERT INTO messages (id, account_id, folder_id, thread_id, from_email, from_name, subject, preview, date_utc,
            seen, pinned, answered, forwarded, draft, server_deleted, has_attachments, draft_id, outbox_state, outbox_error,
            sender_sort_key, subject_sort_key, provider_uid, provider_uid_validity, provider_modseq,
            message_id_header, in_reply_to, references_raw, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET folder_id = excluded.folder_id, thread_id = excluded.thread_id,
            from_email = excluded.from_email, from_name = excluded.from_name, subject = excluded.subject,
            preview = excluded.preview, date_utc = excluded.date_utc, seen = excluded.seen,
            pinned = excluded.pinned,
            answered = excluded.answered, forwarded = excluded.forwarded, draft = excluded.draft,
            server_deleted = excluded.server_deleted, has_attachments = excluded.has_attachments,
            draft_id = excluded.draft_id, outbox_state = excluded.outbox_state, outbox_error = excluded.outbox_error,
            sender_sort_key = excluded.sender_sort_key, subject_sort_key = excluded.subject_sort_key,
            provider_uid = excluded.provider_uid, provider_uid_validity = excluded.provider_uid_validity,
            provider_modseq = excluded.provider_modseq, message_id_header = excluded.message_id_header,
            in_reply_to = excluded.in_reply_to, references_raw = excluded.references_raw, updated_at = excluded.updated_at
         WHERE messages.account_id = excluded.account_id`,
        [
          message.id, account.id, message.folderId, message.threadId, message.from.email, message.from.name, message.subject, message.preview,
          new Date(message.date).toISOString(),
          bit(message.seen), bit(message.pinned), bit(message.answered), bit(message.forwarded), bit(message.draft),
          bit(stored.serverDeleted ?? false), bit(message.hasAttachments), message.draftId ?? null,
          message.outbox.state, message.outbox.error ?? null,
          trLower(sender).slice(0, SORT_KEY_LENGTH), trLower(message.subject).slice(0, SORT_KEY_LENGTH),
          provider?.uid ?? null, provider?.uidValidity ?? null, provider?.modSeq ?? null,
          provider?.messageIdHeader ?? null, provider?.inReplyTo ?? null, provider?.references ?? null,
          now, now,
        ],
      );
      if (changes === 0) throw new DatabaseError('message id belongs to another account');

      // Recipients: replaced as a set, order preserved by `position` within each kind.
      await this.db.run('DELETE FROM message_recipients WHERE message_id = ?', [message.id]);
      for (const [kind, list] of [['to', message.to], ['cc', message.cc], ['bcc', message.bcc]] as const) {
        for (const [position, address] of list.entries()) {
          await this.db.run('INSERT INTO message_recipients (message_id, kind, position, email, name) VALUES (?, ?, ?, ?, ?)', [message.id, kind, position, address.email, address.name]);
        }
      }

      // Body: only sanitised HTML is ever accepted (`sanitized: true` is a literal in the contract type).
      if (message.body.text === null && message.body.html === null) {
        await this.db.run('DELETE FROM message_bodies WHERE message_id = ?', [message.id]);
      } else {
        await this.db.run(
          `INSERT INTO message_bodies (message_id, plain_text, sanitized_html, fetched_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (message_id) DO UPDATE SET plain_text = excluded.plain_text, sanitized_html = excluded.sanitized_html, fetched_at = excluded.fetched_at`,
          [message.id, message.body.text, message.body.html?.content ?? null, now],
        );
      }

      await this.db.run('DELETE FROM message_labels WHERE message_id = ?', [message.id]);
      for (const labelId of labelIds) await this.db.run('INSERT INTO message_labels (message_id, label_id) VALUES (?, ?)', [message.id, labelId]);

      // Attachment METADATA only.
      await this.db.run('DELETE FROM attachments WHERE message_id = ?', [message.id]);
      for (const a of message.attachments) {
        await this.db.run(
          `INSERT INTO attachments (id, message_id, file_name, mime_type, size_bytes, is_inline, provider_part_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [a.id, message.id, a.fileName, a.mimeType, a.sizeBytes, bit(a.isInline), stored.attachmentParts?.[a.id] ?? null, now],
        );
      }

      // Search index (mobile parity: folded text of subject, sender, preview and plain body).
      const content = foldForSearch([message.subject, message.from.name, message.from.email, message.preview, message.body.text ?? ''].filter((p) => p !== '').join(' '));
      await this.db.run('DELETE FROM messages_fts WHERE rowid = (SELECT rowid FROM messages WHERE id = ?)', [message.id]);
      await this.db.run('INSERT INTO messages_fts (rowid, content) VALUES ((SELECT rowid FROM messages WHERE id = ?), ?)', [message.id, content]);
    });
  }

  async removeMessage(account: AuthorizedAccount, messageId: string): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.run('DELETE FROM messages_fts WHERE rowid = (SELECT rowid FROM messages WHERE id = ? AND account_id = ?)', [messageId, account.id]);
      await this.db.run('DELETE FROM messages WHERE id = ? AND account_id = ?', [messageId, account.id]);
    });
  }

  async providerRefOfMessage(account: AuthorizedAccount, messageId: string): Promise<ProviderMessageRef | null> {
    const r = await this.db.get(
      `SELECT provider_uid, provider_uid_validity, provider_modseq, message_id_header, in_reply_to, references_raw
       FROM messages WHERE id = ? AND account_id = ?`,
      [messageId, account.id],
    );
    if (r === undefined) return null;
    return {
      uid: intOrNull(r['provider_uid']),
      uidValidity: intOrNull(r['provider_uid_validity']),
      modSeq: intOrNull(r['provider_modseq']),
      messageIdHeader: textOrNull(r['message_id_header']),
      inReplyTo: textOrNull(r['in_reply_to']),
      references: textOrNull(r['references_raw']),
    };
  }

  async providerRefOfFolder(account: AuthorizedAccount, folderId: string): Promise<ProviderFolderRef | null> {
    const r = await this.db.get(
      'SELECT provider_path, provider_delimiter, provider_uid_validity, provider_uid_next, provider_highest_modseq FROM folders WHERE id = ? AND account_id = ?',
      [folderId, account.id],
    );
    if (r === undefined) return null;
    return {
      path: text(r['provider_path']),
      delimiter: text(r['provider_delimiter']),
      uidValidity: intOrNull(r['provider_uid_validity']),
      uidNext: intOrNull(r['provider_uid_next']),
      highestModSeq: intOrNull(r['provider_highest_modseq']),
    };
  }

  async findMessageByProviderUid(
    account: AuthorizedAccount,
    folderId: string,
    uidValidity: number,
    uid: number,
  ): Promise<{ readonly id: string; readonly messageIdHeader: string | null; readonly pinned: boolean } | null> {
    const r = await this.db.get(
      'SELECT id, message_id_header, pinned FROM messages WHERE account_id = ? AND folder_id = ? AND provider_uid_validity = ? AND provider_uid = ?',
      [account.id, folderId, uidValidity, uid],
    );
    if (r === undefined) return null;
    return {
      id: text(r['id']),
      messageIdHeader: textOrNull(r['message_id_header']),
      pinned: flag(r['pinned']),
    };
  }

  async findMessageByHeaderId(
    account: AuthorizedAccount,
    messageIdHeader: string,
  ): Promise<{ readonly id: string; readonly folderId: string; readonly pinned: boolean; readonly fromEmail: string; readonly dateUtc: string } | null> {
    const r = await this.db.get(
      'SELECT id, folder_id, pinned, from_email, date_utc FROM messages WHERE account_id = ? AND message_id_header = ? ORDER BY date_utc DESC LIMIT 1',
      [account.id, messageIdHeader],
    );
    if (r === undefined) return null;
    return {
      id: text(r['id']),
      folderId: text(r['folder_id']),
      pinned: flag(r['pinned']),
      fromEmail: text(r['from_email']),
      dateUtc: text(r['date_utc']),
    };
  }

  async getMailboxUids(account: AuthorizedAccount, folderId: string): Promise<readonly number[]> {
    const rows = await this.db.all(
      'SELECT provider_uid FROM messages WHERE account_id = ? AND folder_id = ? AND provider_uid IS NOT NULL ORDER BY provider_uid ASC',
      [account.id, folderId],
    );
    return rows.map((r) => int(r['provider_uid']));
  }

  async removeMessagesByUids(account: AuthorizedAccount, folderId: string, uids: readonly number[]): Promise<number> {
    if (uids.length === 0) return 0;
    return await this.db.transaction(async () => {
      const ph = placeholders(uids.length);
      await this.db.run(
        `DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE account_id = ? AND folder_id = ? AND provider_uid IN (${ph}))`,
        [account.id, folderId, ...uids],
      );
      const { changes } = await this.db.run(
        `DELETE FROM messages WHERE account_id = ? AND folder_id = ? AND provider_uid IN (${ph})`,
        [account.id, folderId, ...uids],
      );
      return changes;
    });
  }

  async clearFolderMessages(account: AuthorizedAccount, folderId: string): Promise<number> {
    return await this.db.transaction(async () => {
      await this.db.run(
        `DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE account_id = ? AND folder_id = ? AND provider_uid IS NOT NULL AND draft = 0)`,
        [account.id, folderId],
      );
      const { changes } = await this.db.run(
        'DELETE FROM messages WHERE account_id = ? AND folder_id = ? AND provider_uid IS NOT NULL AND draft = 0',
        [account.id, folderId],
      );
      return changes;
    });
  }

  async updateMessageFlagsByUid(
    account: AuthorizedAccount,
    folderId: string,
    uid: number,
    flags: {
      seen?: boolean;
      pinned?: boolean;
      answered?: boolean;
      forwarded?: boolean;
      serverDeleted?: boolean;
    },
  ): Promise<boolean> {
    const sets: string[] = ['updated_at = ?'];
    const values: Array<string | number | bigint | null> = [toIso(this.clock.now())];

    if (flags.seen !== undefined) {
      sets.push('seen = ?');
      values.push(bit(flags.seen));
    }
    if (flags.pinned !== undefined) {
      sets.push('pinned = ?');
      values.push(bit(flags.pinned));
    }
    if (flags.answered !== undefined) {
      sets.push('answered = ?');
      values.push(bit(flags.answered));
    }
    if (flags.forwarded !== undefined) {
      sets.push('forwarded = ?');
      values.push(bit(flags.forwarded));
    }
    if (flags.serverDeleted !== undefined) {
      sets.push('server_deleted = ?');
      values.push(bit(flags.serverDeleted));
    }

    values.push(account.id, folderId, uid);
    const { changes } = await this.db.run(
      `UPDATE messages SET ${sets.join(', ')} WHERE account_id = ? AND folder_id = ? AND provider_uid = ?`,
      values,
    );
    return changes > 0;
  }
}

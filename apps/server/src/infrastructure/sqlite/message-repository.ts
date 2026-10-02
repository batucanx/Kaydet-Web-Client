import { tokenizeSearchQuery } from '@kaydet/domain';
import type { AttachmentDTO, EmailAddressDTO, FolderRole, MessageDTO, MessageSort, MessageSummaryDTO, OutboxState, SearchResultDTO } from '@kaydet/domain';
import { AppError } from '../../application/index.ts';
import type {
  AuthorizedAccount,
  MessageListQuery,
  MessageLocation,
  MessageRepository,
  MessageSearchQuery,
  RepositoryPage,
} from '../../application/index.ts';
import { chunks, flag, fromIso, isIso, placeholders, text, textOrNull } from './common.ts';
import type { Params } from './common.ts';
import type { SqliteDatabase } from './database.ts';

/**
 * API-facing columns only. Provider identity (uid, uidvalidity, modseq, Message-ID header, …) is NEVER selected here: this
 * repository cannot return it, so it cannot reach a DTO. (Its writer, `SqliteMailStore`, is a separate port.)
 */
const SUMMARY_COLUMNS = `m.id, m.account_id, m.folder_id, m.thread_id, m.from_email, m.from_name, m.subject, m.preview, m.date_utc,
  m.seen, m.pinned, m.answered, m.forwarded, m.draft, m.has_attachments, m.draft_id, m.outbox_state, m.outbox_error`;

type SummaryRow = Record<string, unknown>;

/** Bound on the position payload, so a cursor always fits the contract's 2048-character limit. */
const MAX_KEY_LENGTH = 200;

/** Sort key parts of a page position. The position is UNTRUSTED input (it came from a browser cursor). */
interface Position {
  readonly key: string;
  readonly id: string;
}

function encodePosition(key: string, id: string): string {
  return JSON.stringify([key, id]);
}

function decodePosition(position: string, sort: MessageSort | 'search'): Position {
  const invalid = () => new AppError('invalid_cursor');
  let parsed: unknown;
  try {
    parsed = JSON.parse(position);
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw invalid();
  const [key, id] = parsed as unknown[];
  if (typeof key !== 'string' || typeof id !== 'string' || key.length > MAX_KEY_LENGTH * 4 || id.length === 0 || id.length > 256) throw invalid();
  if ((sort === 'dateDesc' || sort === 'dateAsc' || sort === 'search') && !isIso(key)) throw invalid();
  return { key, id };
}

function toAddress(email: unknown, name: unknown): EmailAddressDTO {
  return { email: text(email), name: text(name) };
}

export class SqliteMessageRepository implements MessageRepository {
  constructor(private readonly db: SqliteDatabase) {}

  // ── one message ─────────────────────────────────────────────────────────

  async findOwned(userId: string, messageId: string): Promise<MessageDTO | null> {
    const row = await this.db.get<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM messages m JOIN mail_accounts a ON a.id = m.account_id
       WHERE m.id = ? AND a.user_id = ? AND m.server_deleted = 0`,
      [messageId, userId],
    );
    if (row === undefined) return null;

    const [summary] = await this.assemble([row]);
    if (summary === undefined) return null;
    const [recipients, body, attachments] = await Promise.all([
      this.db.all('SELECT kind, email, name FROM message_recipients WHERE message_id = ? AND kind IN (\'cc\', \'bcc\') ORDER BY kind, position', [messageId]),
      this.db.get('SELECT plain_text, sanitized_html FROM message_bodies WHERE message_id = ?', [messageId]),
      this.db.all(
        'SELECT id, file_name, mime_type, size_bytes, is_inline FROM attachments WHERE message_id = ? ORDER BY created_at, rowid',
        [messageId],
      ),
    ]);
    const kind = (k: string) => recipients.filter((r) => r['kind'] === k).map((r) => toAddress(r['email'], r['name']));
    const html = textOrNull(body?.['sanitized_html']);
    return {
      ...summary,
      cc: kind('cc'),
      bcc: kind('bcc'),
      body: { text: textOrNull(body?.['plain_text']), html: html === null ? null : { content: html, sanitized: true } },
      attachments: attachments.map(
        (a): AttachmentDTO => ({ id: text(a['id']), messageId, fileName: text(a['file_name']), mimeType: text(a['mime_type']), sizeBytes: Number(a['size_bytes']), isInline: flag(a['is_inline']) }),
      ),
    };
  }

  async locateOwned(userId: string, messageIds: readonly string[]): Promise<Map<string, MessageLocation>> {
    const found = new Map<string, MessageLocation>();
    for (const part of chunks(messageIds)) {
      const rows = await this.db.all(
        `SELECT m.id, m.account_id, m.folder_id, f.role, m.draft FROM messages m
         JOIN mail_accounts a ON a.id = m.account_id JOIN folders f ON f.id = m.folder_id
         WHERE a.user_id = ? AND m.server_deleted = 0 AND m.id IN (${placeholders(part.length)})`,
        [userId, ...part],
      );
      for (const r of rows) {
        found.set(text(r['id']), { accountId: text(r['account_id']), folderId: text(r['folder_id']), folderRole: text(r['role']) as FolderRole, draft: flag(r['draft']) });
      }
    }
    return found;
  }

  // ── lists ───────────────────────────────────────────────────────────────

  async listPage(account: AuthorizedAccount, query: MessageListQuery): Promise<RepositoryPage<MessageSummaryDTO>> {
    const { scope, filter, page } = query;
    const where: string[] = ['m.account_id = ?', 'm.server_deleted = 0'];
    const params: Params = [account.id];
    if (scope.kind === 'folder') {
      where.push('m.folder_id = ?');
      params.push(scope.folderId);
    } else {
      where.push('m.pinned = 1');
    }
    if (filter.unread) where.push('m.seen = 0');
    if (filter.pinned) where.push('m.pinned = 1');
    if (filter.attachments) where.push('m.has_attachments = 1');
    if (filter.label !== null) {
      where.push('EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = m.id AND l.name = ?)');
      params.push(filter.label);
    }

    // Sort column + direction. The keyset (sort value, id) makes the order total and the cursor stable.
    const spec = {
      dateDesc: { column: 'm.date_utc', dir: 'DESC', cmp: '<' },
      dateAsc: { column: 'm.date_utc', dir: 'ASC', cmp: '>' },
      senderAZ: { column: 'm.sender_sort_key', dir: 'ASC', cmp: '>' },
      subjectAZ: { column: 'm.subject_sort_key', dir: 'ASC', cmp: '>' },
    }[filter.sort];
    if (page.position !== null) {
      const at = decodePosition(page.position, filter.sort);
      where.push(`(${spec.column}, m.id) ${spec.cmp} (?, ?)`);
      params.push(at.key, at.id);
    }

    const rows = await this.db.all<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS}, ${spec.column} AS sort_value FROM messages m WHERE ${where.join(' AND ')}
       ORDER BY ${spec.column} ${spec.dir}, m.id ${spec.dir} LIMIT ?`,
      [...params, page.limit + 1],
    );
    const pageRows = rows.slice(0, page.limit);
    const last = pageRows.at(-1);
    return {
      items: await this.assemble(pageRows),
      nextPosition: rows.length > page.limit && last !== undefined ? encodePosition(text(last['sort_value']), text(last['id'])) : null,
    };
  }

  async search(accounts: readonly AuthorizedAccount[], query: MessageSearchQuery): Promise<RepositoryPage<SearchResultDTO>> {
    // Same rule as mobile: fold + tokenise in the DOMAIN, then a prefix match per token. Tokens contain only letters and
    // digits, so the quoted FTS5 expression cannot carry query syntax.
    const tokens = tokenizeSearchQuery(query.q);
    if (tokens.length === 0 || accounts.length === 0) return { items: [], nextPosition: null };
    const match = tokens.map((t) => `"${t}"*`).join(' ');

    const where: string[] = ['messages_fts MATCH ?', `m.account_id IN (${placeholders(accounts.length)})`, 'm.server_deleted = 0'];
    const params: Params = [match, ...accounts.map((a) => a.id)];
    const { filters, dateRange } = query;
    if (filters.attachmentsOnly) where.push('m.has_attachments = 1');
    if (filters.folder === null) {
      if (!filters.includeDeleted) where.push("fo.role <> 'trash'");
    } else {
      where.push('fo.role = ?');
      params.push(filters.folder.role);
      if (filters.folder.name !== undefined) {
        where.push('fo.name = ?');
        params.push(filters.folder.name);
      }
    }
    if (dateRange?.after !== undefined) {
      where.push('m.date_utc >= ?');
      params.push(new Date(dateRange.after).toISOString());
    }
    if (dateRange?.before !== undefined) {
      where.push('m.date_utc < ?');
      params.push(new Date(dateRange.before).toISOString());
    }
    if (query.page.position !== null) {
      const at = decodePosition(query.page.position, 'search');
      where.push('(m.date_utc, m.id) < (?, ?)');
      params.push(at.key, at.id);
    }

    // Newest first (not relevance), like mobile; the sort is applied BEFORE the limit.
    const rows = await this.db.all<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS}, fo.name AS folder_name, fo.role AS folder_role
       FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid JOIN folders fo ON fo.id = m.folder_id
       WHERE ${where.join(' AND ')} ORDER BY m.date_utc DESC, m.id DESC LIMIT ?`,
      [...params, query.page.limit + 1],
    );
    const pageRows = rows.slice(0, query.page.limit);
    const summaries = await this.assemble(pageRows);
    const last = pageRows.at(-1);
    return {
      items: summaries.map((message, i): SearchResultDTO => {
        const row = pageRows[i] as SummaryRow;
        return { message, folder: { id: message.folderId, name: text(row['folder_name']), role: text(row['folder_role']) as FolderRole } };
      }),
      nextPosition: rows.length > query.page.limit && last !== undefined ? encodePosition(text(last['date_utc']), text(last['id'])) : null,
    };
  }

  // ── row → DTO ───────────────────────────────────────────────────────────

  /** Summary rows → DTOs, loading recipients ("to") and label names for the whole page in two queries. */
  private async assemble(rows: readonly SummaryRow[]): Promise<MessageSummaryDTO[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => text(r['id']));
    const to = new Map<string, EmailAddressDTO[]>();
    const labels = new Map<string, string[]>();
    for (const part of chunks(ids)) {
      const marks = placeholders(part.length);
      for (const r of await this.db.all(`SELECT message_id, email, name FROM message_recipients WHERE kind = 'to' AND message_id IN (${marks}) ORDER BY message_id, position`, part)) {
        const id = text(r['message_id']);
        to.set(id, [...(to.get(id) ?? []), toAddress(r['email'], r['name'])]);
      }
      for (const r of await this.db.all(
        `SELECT ml.message_id, l.name FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id IN (${marks}) ORDER BY ml.message_id, l.name_key`,
        part,
      )) {
        const id = text(r['message_id']);
        labels.set(id, [...(labels.get(id) ?? []), text(r['name'])]);
      }
    }
    return rows.map((r): MessageSummaryDTO => {
      const id = text(r['id']);
      const error = textOrNull(r['outbox_error']);
      const draftId = textOrNull(r['draft_id']);
      return {
        id,
        accountId: text(r['account_id']),
        folderId: text(r['folder_id']),
        threadId: text(r['thread_id']),
        from: toAddress(r['from_email'], r['from_name']),
        to: to.get(id) ?? [],
        subject: text(r['subject']),
        preview: text(r['preview']),
        date: fromIso(text(r['date_utc'])).toISOString(),
        seen: flag(r['seen']),
        pinned: flag(r['pinned']),
        answered: flag(r['answered']),
        forwarded: flag(r['forwarded']),
        draft: flag(r['draft']),
        hasAttachments: flag(r['has_attachments']),
        ...(draftId === null ? {} : { draftId }),
        labels: labels.get(id) ?? [],
        outbox: { state: text(r['outbox_state']) as OutboxState, ...(error === null ? {} : { error }) },
      };
    });
  }
}

import { foldForSearch } from '@kaydet/domain';
import type { LabelDTO, SignatureDTO, TemplateDTO } from '@kaydet/domain';
import { AppError } from '../../application/index.ts';
import type { AuthorizedAccount, Clock, LabelRepository, SignatureRepository, TemplateRepository } from '../../application/index.ts';
import { bit, flag, int, text, toIso } from './common.ts';
import { isUniqueViolation } from './database.ts';
import type { SqliteDatabase } from './database.ts';

type Row = Record<string, unknown>;

/** Labels of an account. Names are unique per account by their domain-folded key (`Kişisel` = `kisisel`). */
export class SqliteLabelRepository implements LabelRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  private static toLabel(r: Row): LabelDTO {
    return { id: text(r['id']), accountId: text(r['account_id']), name: text(r['name']), tone: int(r['tone']) };
  }

  async list(account: AuthorizedAccount): Promise<LabelDTO[]> {
    return (await this.db.all('SELECT id, account_id, name, tone FROM labels WHERE account_id = ? ORDER BY rowid', [account.id])).map(SqliteLabelRepository.toLabel);
  }

  async find(account: AuthorizedAccount, labelId: string): Promise<LabelDTO | null> {
    const r = await this.db.get('SELECT id, account_id, name, tone FROM labels WHERE account_id = ? AND id = ?', [account.id, labelId]);
    return r === undefined ? null : SqliteLabelRepository.toLabel(r);
  }

  async save(account: AuthorizedAccount, label: LabelDTO): Promise<void> {
    try {
      await this.db.run(
        `INSERT INTO labels (id, account_id, name, name_key, tone, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key, tone = excluded.tone
         WHERE labels.account_id = excluded.account_id`,
        [label.id, account.id, label.name, foldForSearch(label.name), label.tone, toIso(this.clock.now())],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError('label_exists');
      throw error;
    }
  }

  /** Message associations go with the label (ON DELETE CASCADE): none can be left pointing at nothing. */
  async remove(account: AuthorizedAccount, labelId: string): Promise<void> {
    await this.db.run('DELETE FROM labels WHERE id = ? AND account_id = ?', [labelId, account.id]);
  }
}

export class SqliteSignatureRepository implements SignatureRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  private static toSignature(r: Row): SignatureDTO {
    return { id: text(r['id']), accountId: text(r['account_id']), name: text(r['name']), body: text(r['body']), isDefault: flag(r['is_default']) };
  }

  async list(account: AuthorizedAccount): Promise<SignatureDTO[]> {
    return (await this.db.all('SELECT id, account_id, name, body, is_default FROM signatures WHERE account_id = ? ORDER BY rowid', [account.id])).map(SqliteSignatureRepository.toSignature);
  }

  async find(account: AuthorizedAccount, signatureId: string): Promise<SignatureDTO | null> {
    const r = await this.db.get('SELECT id, account_id, name, body, is_default FROM signatures WHERE account_id = ? AND id = ?', [account.id, signatureId]);
    return r === undefined ? null : SqliteSignatureRepository.toSignature(r);
  }

  async save(account: AuthorizedAccount, signature: SignatureDTO): Promise<void> {
    const now = toIso(this.clock.now());
    await this.db.run(
      `INSERT INTO signatures (account_id, id, name, body, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, id) DO UPDATE SET name = excluded.name, body = excluded.body, is_default = excluded.is_default, updated_at = excluded.updated_at`,
      [account.id, signature.id, signature.name, signature.body, bit(signature.isDefault), now, now],
    );
  }

  async remove(account: AuthorizedAccount, signatureId: string): Promise<void> {
    await this.db.run('DELETE FROM signatures WHERE account_id = ? AND id = ?', [account.id, signatureId]);
  }
}

/** Quick templates of a user; the list keeps insertion order (an update keeps its place, like the mobile list). */
export class SqliteTemplateRepository implements TemplateRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  private static toTemplate(r: Row): TemplateDTO {
    return { id: text(r['id']), title: text(r['title']), content: text(r['content']), isBuiltIn: flag(r['is_built_in']) };
  }

  async list(userId: string): Promise<TemplateDTO[]> {
    return (await this.db.all('SELECT id, title, content, is_built_in FROM templates WHERE user_id = ? ORDER BY rowid', [userId])).map(SqliteTemplateRepository.toTemplate);
  }

  async find(userId: string, templateId: string): Promise<TemplateDTO | null> {
    const r = await this.db.get('SELECT id, title, content, is_built_in FROM templates WHERE user_id = ? AND id = ?', [userId, templateId]);
    return r === undefined ? null : SqliteTemplateRepository.toTemplate(r);
  }

  async save(userId: string, template: TemplateDTO): Promise<void> {
    const now = toIso(this.clock.now());
    await this.db.run(
      `INSERT INTO templates (user_id, id, title, content, is_built_in, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, id) DO UPDATE SET title = excluded.title, content = excluded.content, is_built_in = excluded.is_built_in, updated_at = excluded.updated_at`,
      [userId, template.id, template.title, template.content, bit(template.isBuiltIn), now, now],
    );
  }

  async remove(userId: string, templateId: string): Promise<void> {
    await this.db.run('DELETE FROM templates WHERE user_id = ? AND id = ?', [userId, templateId]);
  }
}

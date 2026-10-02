import type { LabelDTO, SignatureDTO, TemplateDTO } from '@kaydet/domain';
import type { AuthorizedAccount } from '../../context/authorized-account.ts';

export interface LabelRepository {
  list(account: AuthorizedAccount): Promise<LabelDTO[]>;
  find(account: AuthorizedAccount, labelId: string): Promise<LabelDTO | null>;
  save(account: AuthorizedAccount, label: LabelDTO): Promise<void>;
  remove(account: AuthorizedAccount, labelId: string): Promise<void>;
}

export interface SignatureRepository {
  list(account: AuthorizedAccount): Promise<SignatureDTO[]>;
  find(account: AuthorizedAccount, signatureId: string): Promise<SignatureDTO | null>;
  save(account: AuthorizedAccount, signature: SignatureDTO): Promise<void>;
  remove(account: AuthorizedAccount, signatureId: string): Promise<void>;
}

/** Quick templates belong to the Kaydet user, not to a mail account. */
export interface TemplateRepository {
  list(userId: string): Promise<TemplateDTO[]>;
  find(userId: string, templateId: string): Promise<TemplateDTO | null>;
  save(userId: string, template: TemplateDTO): Promise<void>;
  remove(userId: string, templateId: string): Promise<void>;
}

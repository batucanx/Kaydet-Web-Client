import { foldForSearch } from '@kaydet/domain';
import type { LabelCreateRequest, LabelDTO, SignatureDTO, SignatureUpsertRequest, TemplateDTO, TemplateUpsertRequest } from '@kaydet/domain';
import { AppError, defineUseCase } from '../errors.ts';
import type { RequestContext } from '../context/request-context.ts';
import type { UseCaseDeps } from './deps.ts';

export function createLabelUseCases({ access, labels, ids }: Pick<UseCaseDeps, 'access' | 'labels' | 'ids'>) {
  return {
    listLabels: defineUseCase('labels.list', async (ctx: RequestContext, accountId: string): Promise<{ items: LabelDTO[] }> => ({
      items: await labels.list(await access.authorize(ctx, accountId)),
    })),

    createLabel: defineUseCase('labels.create', async (ctx: RequestContext, accountId: string, request: LabelCreateRequest): Promise<LabelDTO> => {
      const account = await access.authorize(ctx, accountId);
      // Names are unique per account, compared the way search folds Turkish text (`Kişisel` = `kisisel`).
      const key = foldForSearch(request.name);
      if ((await labels.list(account)).some((l) => foldForSearch(l.name) === key)) throw new AppError('label_exists');
      const label: LabelDTO = { id: ids.next(), accountId: account.id, name: request.name, tone: request.tone };
      await labels.save(account, label);
      return label;
    }),

    deleteLabel: defineUseCase('labels.delete', async (ctx: RequestContext, accountId: string, labelId: string): Promise<void> => {
      const account = await access.authorize(ctx, accountId);
      if ((await labels.find(account, labelId)) === null) throw new AppError('label_not_found');
      await labels.remove(account, labelId);
    }),
  };
}

export function createSignatureUseCases({ access, signatures, transactions }: Pick<UseCaseDeps, 'access' | 'signatures' | 'transactions'>) {
  return {
    listSignatures: defineUseCase('signatures.list', async (ctx: RequestContext, accountId: string): Promise<{ items: SignatureDTO[] }> => ({
      items: await signatures.list(await access.authorize(ctx, accountId)),
    })),

    /** Idempotent upsert with a client-generated id; a new default clears the flag on the others. */
    putSignature: defineUseCase('signatures.put', async (ctx: RequestContext, accountId: string, signatureId: string, request: SignatureUpsertRequest): Promise<SignatureDTO> => {
      const account = await access.authorize(ctx, accountId);
      const signature: SignatureDTO = { id: signatureId, accountId: account.id, name: request.name, body: request.body, isDefault: request.isDefault };
      // ATOMIC: "at most one default" must hold at every commit (the database enforces it too).
      await transactions.run(async () => {
        if (request.isDefault) {
          for (const other of await signatures.list(account)) {
            if (other.id !== signatureId && other.isDefault) await signatures.save(account, { ...other, isDefault: false });
          }
        }
        await signatures.save(account, signature);
      });
      return signature;
    }),

    deleteSignature: defineUseCase('signatures.delete', async (ctx: RequestContext, accountId: string, signatureId: string): Promise<void> => {
      const account = await access.authorize(ctx, accountId);
      if ((await signatures.find(account, signatureId)) === null) throw new AppError('signature_not_found');
      await signatures.remove(account, signatureId);
    }),
  };
}

export function createTemplateUseCases({ access, templates }: Pick<UseCaseDeps, 'access' | 'templates'>) {
  return {
    listTemplates: defineUseCase('templates.list', async (ctx: RequestContext): Promise<{ items: TemplateDTO[] }> => ({
      items: await templates.list(access.requireUserId(ctx)),
    })),

    putTemplate: defineUseCase('templates.put', async (ctx: RequestContext, templateId: string, request: TemplateUpsertRequest): Promise<TemplateDTO> => {
      const userId = access.requireUserId(ctx);
      const existing = await templates.find(userId, templateId);
      const template: TemplateDTO = { id: templateId, title: request.title, content: request.content, isBuiltIn: existing?.isBuiltIn ?? false };
      await templates.save(userId, template);
      return template;
    }),

    deleteTemplate: defineUseCase('templates.delete', async (ctx: RequestContext, templateId: string): Promise<void> => {
      const userId = access.requireUserId(ctx);
      if ((await templates.find(userId, templateId)) === null) throw new AppError('template_not_found');
      await templates.remove(userId, templateId);
    }),
  };
}

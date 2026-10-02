import { isSystemFolder } from '@kaydet/domain';
import type { FolderCreateRequest, FolderDTO, FolderUpdateRequest } from '@kaydet/domain';
import { AppError, defineUseCase } from '../errors.ts';
import type { AuthorizedAccount } from '../context/authorized-account.ts';
import type { RequestContext } from '../context/request-context.ts';
import type { UseCaseDeps } from './deps.ts';

export function createFolderUseCases({ access, folders, mailbox, events }: Pick<UseCaseDeps, 'access' | 'folders' | 'mailbox' | 'events'>) {
  const requireFolder = async (account: AuthorizedAccount, folderId: string): Promise<FolderDTO> => {
    const folder = await folders.find(account, folderId);
    if (folder === null) throw new AppError('folder_not_found');
    return folder;
  };

  /** Is `candidateId` the folder itself or one of its descendants? (moving a folder into its own subtree) */
  const isSelfOrDescendant = async (account: AuthorizedAccount, folderId: string, candidateId: string): Promise<boolean> => {
    const all = new Map((await folders.listByAccount(account)).map((f) => [f.id, f]));
    for (let cursor: string | null = candidateId, hops = 0; cursor !== null && hops <= all.size; hops++) {
      if (cursor === folderId) return true;
      cursor = all.get(cursor)?.parentId ?? null;
    }
    return false;
  };

  const changed = (account: AuthorizedAccount) => events.publish(account.userId, { type: 'folders.changed', accountId: account.id });

  return {
    listFolders: defineUseCase('folders.list', async (ctx: RequestContext, accountId: string): Promise<{ items: FolderDTO[] }> => {
      const account = await access.authorize(ctx, accountId);
      return { items: await folders.listByAccount(account) };
    }),

    createFolder: defineUseCase('folders.create', async (ctx: RequestContext, accountId: string, request: FolderCreateRequest): Promise<FolderDTO> => {
      const account = await access.authorize(ctx, accountId);
      if (request.parentId !== null) await requireFolder(account, request.parentId);
      const created = await mailbox.createFolder(account, request);
      changed(account);
      return created;
    }),

    updateFolder: defineUseCase('folders.update', async (ctx: RequestContext, accountId: string, folderId: string, patch: FolderUpdateRequest): Promise<FolderDTO> => {
      const account = await access.authorize(ctx, accountId);
      const folder = await requireFolder(account, folderId);
      const restructures = patch.name !== undefined || patch.parentId !== undefined;
      if (restructures && isSystemFolder(folder.role)) throw new AppError('system_folder_protected');
      if (patch.parentId !== undefined && patch.parentId !== null) {
        await requireFolder(account, patch.parentId);
        if (await isSelfOrDescendant(account, folderId, patch.parentId)) throw new AppError('invalid_folder_move');
      }
      const updated = await mailbox.updateFolder(account, folderId, patch);
      changed(account);
      return updated;
    }),

    deleteFolder: defineUseCase('folders.delete', async (ctx: RequestContext, accountId: string, folderId: string): Promise<void> => {
      const account = await access.authorize(ctx, accountId);
      const folder = await requireFolder(account, folderId);
      if (isSystemFolder(folder.role)) throw new AppError('system_folder_protected');
      if (folder.hasChildren) throw new AppError('folder_has_children');
      await mailbox.deleteFolder(account, folderId);
      changed(account);
    }),
  };
}

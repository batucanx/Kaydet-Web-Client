import type { UseCases } from '../../application/index.ts';
import type { RouteRegistrar } from '../route-registry.ts';

export function registerFolderRoutes(r: RouteRegistrar, u: UseCases): void {
  r.bind('listFolders', ({ ctx, params }) => u.listFolders(ctx, params.accountId));
  r.bind('createFolder', ({ ctx, params, body }) => u.createFolder(ctx, params.accountId, body));
  r.bind('updateFolder', ({ ctx, params, body }) => u.updateFolder(ctx, params.accountId, params.folderId, body));
  r.bind('deleteFolder', ({ ctx, params }) => u.deleteFolder(ctx, params.accountId, params.folderId));
}

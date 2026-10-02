import { allowedActionTypes, createApiError, deleteBehavior, messageListKey } from '@kaydet/domain';
import type {
  MessageActionsRequest,
  MessageActionsResponse,
  MessageDTO,
  MessageListParams,
  MessagePageDTO,
  UndoResponse,
} from '@kaydet/domain';
import { AppError, defineUseCase } from '../errors.ts';
import type { RequestContext } from '../context/request-context.ts';
import { toCursorPage, toPageRequest } from '../pagination.ts';
import type { UseCaseDeps } from './deps.ts';

export function createMessageUseCases({
  access,
  folders,
  labels,
  messages,
  mailbox,
  events,
}: Pick<UseCaseDeps, 'access' | 'folders' | 'labels' | 'messages' | 'mailbox' | 'events'>) {
  return {
    listMessages: defineUseCase('messages.list', async (ctx: RequestContext, accountId: string, params: MessageListParams): Promise<MessagePageDTO> => {
      const account = await access.authorize(ctx, accountId);
      // The folder must belong to THIS account: a folder id of another account is `folder_not_found`.
      if (params.scope.kind === 'folder' && (await folders.find(account, params.scope.folderId)) === null) {
        throw new AppError('folder_not_found');
      }
      const binding = messageListKey(account.id, params.scope, params.filter);
      const page = await messages.listPage(account, {
        scope: params.scope,
        filter: params.filter,
        page: toPageRequest(binding, params.cursor, params.limit),
      });
      return { accountId: account.id, scope: params.scope, ...toCursorPage(binding, page) };
    }),

    getMessage: defineUseCase('messages.get', async (ctx: RequestContext, messageId: string): Promise<MessageDTO> => {
      const message = await messages.findOwned(access.requireUserId(ctx), messageId);
      if (message === null) throw new AppError('message_not_found');
      return message;
    }),

    applyMessageActions: defineUseCase('messages.actions', async (ctx: RequestContext, request: MessageActionsRequest): Promise<MessageActionsResponse> => {
      const account = await access.authorize(ctx, request.accountId);
      const locations = await messages.locateOwned(account.userId, request.messageIds);

      const found = request.messageIds.filter((id) => locations.has(id));
      if (found.length === 0) throw new AppError('message_not_found');
      // A batch never spans accounts.
      if (found.some((id) => locations.get(id)?.accountId !== account.id)) throw new AppError('message_scope_mismatch');

      // Domain rules (mobile): which actions a message allows. `delete` in Trash/Junk/Drafts is irreversible and
      // must be an explicit, confirmed `deletePermanently`; drafts only support deletion.
      for (const id of found) {
        const location = locations.get(id);
        if (location === undefined) continue;
        const allowed = allowedActionTypes({ folderRole: location.folderRole, isDraft: location.draft });
        for (const action of request.actions) {
          if (action.type === 'delete' && deleteBehavior(location.folderRole) === 'permanent') {
            throw new AppError('permanent_delete_requires_confirmation');
          }
          if (!allowed.has(action.type)) throw new AppError('invalid_action_combination');
        }
      }
      for (const action of request.actions) {
        if (action.type === 'move' && (await folders.find(account, action.folderId)) === null) throw new AppError('folder_not_found');
        if (action.type === 'label' && (await labels.find(account, action.labelId)) === null) throw new AppError('label_not_found');
      }

      const result = await mailbox.applyActions({ account, messageIds: found, actions: request.actions });

      if (result.appliedIds.length > 0 && result.affectedFolderIds.length > 0) {
        events.publish(account.userId, { type: 'messages.changed', accountId: account.id, folderIds: [...new Set(result.affectedFolderIds)] });
      }
      const unknown = request.messageIds.filter((id) => !locations.has(id));
      return {
        accountId: account.id,
        appliedIds: [...result.appliedIds],
        failed: [
          ...unknown.map((messageId) => ({ messageId, error: createApiError('message_not_found') })),
          ...result.failed.map((f) => ({ messageId: f.messageId, error: createApiError(f.code) })),
        ],
        undo: result.undo,
      };
    }),

    undoAction: defineUseCase('messages.undo', async (ctx: RequestContext, token: string): Promise<UndoResponse> => {
      const userId = access.requireUserId(ctx);
      const result = await mailbox.undo(userId, token);
      if (!result.restored) return { restored: false };
      if (result.folderIds.length > 0) {
        events.publish(userId, { type: 'messages.changed', accountId: result.accountId, folderIds: [...result.folderIds] });
      }
      return { restored: true };
    }),
  };
}

import type {
  MessageActionsRequest,
  MessageActionsResponse,
  UndoResponse,
} from '@kaydet/domain';
import type { ApiClient } from './client';
import { defaultApiClient } from './client';

export function applyMessageActions(
  client: ApiClient = defaultApiClient,
  request: MessageActionsRequest,
  signal?: AbortSignal,
): Promise<MessageActionsResponse> {
  return client.post<MessageActionsResponse>('/messages/actions', request, { signal });
}

export function undoAction(
  client: ApiClient = defaultApiClient,
  token: string,
  signal?: AbortSignal,
): Promise<UndoResponse> {
  return client.post<UndoResponse>(`/actions/${encodeURIComponent(token)}/undo`, undefined, { signal });
}

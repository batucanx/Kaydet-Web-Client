import { encodeMessageListQuery } from '@kaydet/domain';
import type {
  MessageDTO,
  MessageFilter,
  MessagePageDTO,
  MessageScope,
} from '@kaydet/domain';
import type { ApiClient } from './client';
import { defaultApiClient } from './client';

export interface ListMessagesParams {
  scope: MessageScope;
  filter?: MessageFilter;
  cursor?: string | null;
  limit?: number;
}

export function listMessages(
  client: ApiClient = defaultApiClient,
  accountId: string,
  params: ListMessagesParams,
  signal?: AbortSignal,
): Promise<MessagePageDTO> {
  const query = encodeMessageListQuery(params);
  return client.get<MessagePageDTO>(
    `/accounts/${encodeURIComponent(accountId)}/messages`,
    { query, signal },
  );
}

export function getMessage(
  client: ApiClient = defaultApiClient,
  messageId: string,
  signal?: AbortSignal,
): Promise<MessageDTO> {
  return client.get<MessageDTO>(`/messages/${encodeURIComponent(messageId)}`, { signal });
}

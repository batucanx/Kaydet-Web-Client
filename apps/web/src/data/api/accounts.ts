import type {
  AccountCreateRequest,
  AccountDTO,
  AccountUpdateRequest,
  SyncResponse,
} from '@kaydet/domain';
import type { ApiClient } from './client';
import { defaultApiClient } from './client';

export async function listAccounts(
  client: ApiClient = defaultApiClient,
  signal?: AbortSignal,
): Promise<AccountDTO[]> {
  const res = await client.get<{ items: AccountDTO[] }>('/accounts', { signal });
  return res.items;
}

export function createAccount(
  client: ApiClient = defaultApiClient,
  data: AccountCreateRequest,
): Promise<AccountDTO> {
  return client.post<AccountDTO>('/accounts', data);
}

export function updateAccount(
  client: ApiClient = defaultApiClient,
  accountId: string,
  data: AccountUpdateRequest,
): Promise<AccountDTO> {
  return client.patch<AccountDTO>(`/accounts/${encodeURIComponent(accountId)}`, data);
}

export function deleteAccount(
  client: ApiClient = defaultApiClient,
  accountId: string,
): Promise<void> {
  return client.delete<void>(`/accounts/${encodeURIComponent(accountId)}`);
}

export function syncAccount(
  client: ApiClient = defaultApiClient,
  accountId: string,
): Promise<SyncResponse> {
  return client.post<SyncResponse>(`/accounts/${encodeURIComponent(accountId)}/sync`);
}

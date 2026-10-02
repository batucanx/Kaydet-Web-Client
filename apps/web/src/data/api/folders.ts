import type {
  FolderCreateRequest,
  FolderDTO,
  FolderUpdateRequest,
} from '@kaydet/domain';
import type { ApiClient } from './client';
import { defaultApiClient } from './client';

export async function listFolders(
  client: ApiClient = defaultApiClient,
  accountId: string,
  signal?: AbortSignal,
): Promise<FolderDTO[]> {
  const res = await client.get<{ items: FolderDTO[] }>(
    `/accounts/${encodeURIComponent(accountId)}/folders`,
    { signal },
  );
  return res.items;
}

export function createFolder(
  client: ApiClient = defaultApiClient,
  accountId: string,
  data: FolderCreateRequest,
): Promise<FolderDTO> {
  return client.post<FolderDTO>(
    `/accounts/${encodeURIComponent(accountId)}/folders`,
    data,
  );
}

export function updateFolder(
  client: ApiClient = defaultApiClient,
  accountId: string,
  folderId: string,
  data: FolderUpdateRequest,
): Promise<FolderDTO> {
  return client.patch<FolderDTO>(
    `/accounts/${encodeURIComponent(accountId)}/folders/${encodeURIComponent(folderId)}`,
    data,
  );
}

export function deleteFolder(
  client: ApiClient = defaultApiClient,
  accountId: string,
  folderId: string,
): Promise<void> {
  return client.delete<void>(
    `/accounts/${encodeURIComponent(accountId)}/folders/${encodeURIComponent(folderId)}`,
  );
}

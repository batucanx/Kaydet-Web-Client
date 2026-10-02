import type {
  LabelCreateRequest,
  LabelDTO,
} from '@kaydet/domain';
import type { ApiClient } from './client';
import { defaultApiClient } from './client';

export async function listLabels(
  client: ApiClient = defaultApiClient,
  accountId: string,
  signal?: AbortSignal,
): Promise<LabelDTO[]> {
  const res = await client.get<{ items: LabelDTO[] }>(
    `/accounts/${encodeURIComponent(accountId)}/labels`,
    { signal },
  );
  return res.items;
}

export function createLabel(
  client: ApiClient = defaultApiClient,
  accountId: string,
  data: LabelCreateRequest,
): Promise<LabelDTO> {
  return client.post<LabelDTO>(
    `/accounts/${encodeURIComponent(accountId)}/labels`,
    data,
  );
}

export function deleteLabel(
  client: ApiClient = defaultApiClient,
  accountId: string,
  labelId: string,
): Promise<void> {
  return client.delete<void>(
    `/accounts/${encodeURIComponent(accountId)}/labels/${encodeURIComponent(labelId)}`,
  );
}

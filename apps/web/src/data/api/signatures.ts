import type {
  SignatureDTO,
  SignatureUpsertRequest,
} from '@kaydet/domain';
import type { ApiClient } from './client';
import { defaultApiClient } from './client';

export async function listSignatures(
  client: ApiClient = defaultApiClient,
  accountId: string,
  signal?: AbortSignal,
): Promise<SignatureDTO[]> {
  const res = await client.get<{ items: SignatureDTO[] }>(
    `/accounts/${encodeURIComponent(accountId)}/signatures`,
    { signal },
  );
  return res.items;
}

export function putSignature(
  client: ApiClient = defaultApiClient,
  accountId: string,
  signatureId: string,
  request: SignatureUpsertRequest,
  signal?: AbortSignal,
): Promise<SignatureDTO> {
  return client.put<SignatureDTO>(
    `/accounts/${encodeURIComponent(accountId)}/signatures/${encodeURIComponent(signatureId)}`,
    request,
    { signal },
  );
}

export function deleteSignature(
  client: ApiClient = defaultApiClient,
  accountId: string,
  signatureId: string,
  signal?: AbortSignal,
): Promise<void> {
  return client.delete<void>(
    `/accounts/${encodeURIComponent(accountId)}/signatures/${encodeURIComponent(signatureId)}`,
    { signal },
  );
}

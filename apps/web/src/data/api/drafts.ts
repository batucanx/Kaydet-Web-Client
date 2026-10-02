import type {
  AttachmentDTO,
  DraftDTO,
  DraftInputDTO,
  OutboxCancelResponse,
  OutboxDTO,
} from '@kaydet/domain';
import type { ApiClient } from './client';
import { defaultApiClient } from './client';

export function getDraft(
  client: ApiClient = defaultApiClient,
  draftId: string,
  signal?: AbortSignal,
): Promise<DraftDTO> {
  return client.get<DraftDTO>(`/drafts/${encodeURIComponent(draftId)}`, { signal });
}

export function putDraft(
  client: ApiClient = defaultApiClient,
  draftId: string,
  input: DraftInputDTO,
  signal?: AbortSignal,
): Promise<DraftDTO> {
  return client.put<DraftDTO>(`/drafts/${encodeURIComponent(draftId)}`, input, { signal });
}

export function sendDraft(
  client: ApiClient = defaultApiClient,
  draftId: string,
  signal?: AbortSignal,
): Promise<OutboxDTO> {
  return client.post<OutboxDTO>(`/drafts/${encodeURIComponent(draftId)}/send`, undefined, { signal });
}

export function cancelOutbox(
  client: ApiClient = defaultApiClient,
  outboxId: string,
  signal?: AbortSignal,
): Promise<OutboxCancelResponse> {
  return client.post<OutboxCancelResponse>(`/outbox/${encodeURIComponent(outboxId)}/cancel`, undefined, { signal });
}

export function deleteDraft(
  client: ApiClient = defaultApiClient,
  draftId: string,
  signal?: AbortSignal,
): Promise<void> {
  return client.delete<void>(`/drafts/${encodeURIComponent(draftId)}`, { signal });
}

export async function uploadDraftAttachment(
  client: ApiClient = defaultApiClient,
  draftId: string,
  file: File,
  signal?: AbortSignal,
): Promise<AttachmentDTO> {
  const formData = new FormData();
  formData.append('file', file, file.name);

  return client.post<AttachmentDTO>(
    `/drafts/${encodeURIComponent(draftId)}/attachments`,
    formData,
    { signal },
  );
}

export function deleteDraftAttachment(
  client: ApiClient = defaultApiClient,
  draftId: string,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<void> {
  return client.delete<void>(
    `/drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { signal },
  );
}

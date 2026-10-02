import type { MailboxSessionCreateRequest, SessionDTO } from '@kaydet/domain';
import type { ApiClient } from './client';
import { defaultApiClient } from './client';

export function getSession(client: ApiClient = defaultApiClient, signal?: AbortSignal): Promise<SessionDTO> {
  return client.get<SessionDTO>('/session', { signal });
}

/** Signs in with a mailbox (address + password + IMAP/SMTP servers); the server creates the Kaydet user on first use. */
export function createMailboxSession(
  client: ApiClient = defaultApiClient,
  credentials: MailboxSessionCreateRequest,
): Promise<SessionDTO> {
  return client.post<SessionDTO>('/session/mailbox', credentials);
}

export function deleteSession(client: ApiClient = defaultApiClient): Promise<void> {
  return client.delete<void>('/session');
}

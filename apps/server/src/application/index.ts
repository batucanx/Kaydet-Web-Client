/**
 * Application layer barrel — the ONLY entry point HTTP may import.
 *
 * Deliberately absent: the security ports (`ports/security`, `ports/crypto`), the credential vault, the password
 * hasher and every repository implementation detail. HTTP can call use cases; it cannot hash a password, see a key or
 * decrypt a credential. Infrastructure and the composition root import those from their deep paths.
 */
import type { SecurityPolicy } from '../config/config.types.ts';
import { createAccountAccess } from './services/account-access.ts';
import { createAuthService } from './services/auth-service.ts';
import { createCredentialVault } from './services/credential-vault.ts';
import { createUserAdministration } from './services/user-administration.ts';
import { createAccountUseCases } from './use-cases/accounts.ts';
import { createAttachmentUseCases } from './use-cases/attachments.ts';
import type { ApplicationPorts, UseCaseDeps } from './use-cases/deps.ts';
import { createDraftUseCases } from './use-cases/drafts.ts';
import { createEventUseCases } from './use-cases/events.ts';
import { createFolderUseCases } from './use-cases/folders.ts';
import { createMessageUseCases } from './use-cases/messages.ts';
import { createLabelUseCases, createSignatureUseCases, createTemplateUseCases } from './use-cases/personalisation.ts';
import { createSearchUseCases } from './use-cases/search.ts';
import { createSessionUseCases } from './use-cases/session.ts';

/**
 * Builds the application from ports.
 *  - `useCases`  — what HTTP calls.
 *  - `services`  — internal capabilities that are NOT request handlers: user administration, session revocation, the
 *                  credential resolver for mail adapters, key rotation. Handed to the composition root, never to HTTP.
 */
export function createApplication(ports: ApplicationPorts, policy: Pick<SecurityPolicy, 'session' | 'password' | 'loginLimits'>) {
  const auth = createAuthService({
    users: ports.users,
    sessions: ports.sessions,
    hasher: ports.hasher,
    secrets: ports.sessionSecrets,
    limiter: ports.loginLimiter,
    clock: ports.clock,
    ids: ports.ids,
    transactions: ports.transactions,
    policy,
  });
  const vault = createCredentialVault({ records: ports.credentialRecords, crypto: ports.crypto, clock: ports.clock, transactions: ports.transactions });
  const deps: UseCaseDeps = { ...ports, access: createAccountAccess(ports.accounts), auth, credentials: vault };

  const useCases = {
    ...createSessionUseCases(deps),
    ...createAccountUseCases(deps),
    ...createFolderUseCases(deps),
    ...createMessageUseCases(deps),
    ...createAttachmentUseCases(deps),
    ...createDraftUseCases(deps),
    ...createSearchUseCases(deps),
    ...createLabelUseCases(deps),
    ...createSignatureUseCases(deps),
    ...createTemplateUseCases(deps),
    ...createEventUseCases(deps),
  };
  const services = {
    auth,
    users: createUserAdministration({ users: ports.users, hasher: ports.hasher, clock: ports.clock, ids: ports.ids, password: policy.password }),
    credentials: vault,
  };
  return { useCases, services };
}
export type UseCases = ReturnType<typeof createApplication>['useCases'];
export type ApplicationServices = ReturnType<typeof createApplication>['services'];

export { AppError, defineUseCase, isAppError } from './errors.ts';
export type { AppErrorOptions } from './errors.ts';
export { ANONYMOUS_ACTOR, NO_SESSION } from './context/request-context.ts';
export type { Actor, RequestContext, RequestMetadata, SessionState } from './context/request-context.ts';
export type { AuthorizedAccount } from './context/authorized-account.ts';
export { requireUserId } from './services/account-access.ts';
export type { ResolvedSession } from './services/auth-service.ts';
export type { ApplicationPorts } from './use-cases/deps.ts';
export type { AttachmentDownload } from './use-cases/attachments.ts';
export type { SessionSignIn, SessionView } from './use-cases/session.ts';
export { decodeCursor, encodeCursor, toCursorPage, toPageRequest } from './pagination.ts';
export type { CursorPage, PageRequest, RepositoryPage } from './pagination.ts';
export type { Clock } from './ports/clock/clock.ts';
export type { AddressedEvent, EventBus, EventListener, Unsubscribe } from './ports/events/event-bus.ts';
export type { IdGenerator } from './ports/ids/id-generator.ts';
export type { MailActionRequest, MailActionResult, MailUndoResult, MailboxPort } from './ports/mail/mailbox.ts';
export type { MailSenderPort, OutgoingMessage } from './ports/mail/sender.ts';
export type { HtmlSanitizer } from './ports/mail/html-sanitizer.ts';
export type { ImapProvider, ImapFolderItem, ImapFetchOptions } from './ports/mail/imap-provider.ts';
export type { SmtpProvider, SmtpSendResult } from './ports/mail/smtp-provider.ts';
export type { MailConnectionValidator } from './ports/mail/validator.ts';
export type { AccountRepository } from './ports/repositories/account-repository.ts';
export type { ClaimedOutboxItem, DraftRepository, OutboxRepository, OutboxRetryState } from './ports/repositories/draft-repository.ts';
export type { MailboxSyncState, MailboxSyncStatus, SyncStateRepository } from './ports/mail/sync-state.ts';
export type { FolderRepository } from './ports/repositories/folder-repository.ts';
export type { MessageListQuery, MessageLocation, MessageRepository, MessageSearchQuery } from './ports/repositories/message-repository.ts';
export type { LabelRepository, SignatureRepository, TemplateRepository } from './ports/repositories/personalisation-repositories.ts';
export type { SessionRecord, SessionRepository } from './ports/repositories/session-repository.ts';
export type { UserRecord, UserRepository } from './ports/repositories/user-repository.ts';
export type { CredentialRepository, EncryptedCredentialRecord } from './ports/repositories/credential-repository.ts';
export type { BlobStorage, StoredBlob } from './ports/storage/blob-storage.ts';
export { draftAttachmentBlobKey } from './use-cases/drafts.ts';
export { messageAttachmentBlobKey } from './use-cases/attachments.ts';

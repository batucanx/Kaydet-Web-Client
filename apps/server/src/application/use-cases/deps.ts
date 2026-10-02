import type { CryptoPort } from '../ports/crypto/crypto.ts';
import type { Clock } from '../ports/clock/clock.ts';
import type { EventBus } from '../ports/events/event-bus.ts';
import type { IdGenerator } from '../ports/ids/id-generator.ts';
import type { MailboxPort } from '../ports/mail/mailbox.ts';
import type { AccountRepository } from '../ports/repositories/account-repository.ts';
import type { CredentialRepository } from '../ports/repositories/credential-repository.ts';
import type { DraftRepository, OutboxRepository } from '../ports/repositories/draft-repository.ts';
import type { FolderRepository } from '../ports/repositories/folder-repository.ts';
import type { MessageRepository } from '../ports/repositories/message-repository.ts';
import type { LabelRepository, SignatureRepository, TemplateRepository } from '../ports/repositories/personalisation-repositories.ts';
import type { SessionRepository } from '../ports/repositories/session-repository.ts';
import type { UserRepository } from '../ports/repositories/user-repository.ts';
import type { LoginRateLimiter } from '../ports/security/login-rate-limiter.ts';
import type { MailCredentialWriter } from '../ports/security/mail-credential.ts';
import type { PasswordHasher } from '../ports/security/password-hasher.ts';
import type { SessionSecrets } from '../ports/security/session-secrets.ts';
import type { BlobStorage } from '../ports/storage/blob-storage.ts';
import type { UnitOfWork } from '../ports/transaction/unit-of-work.ts';
import type { AccountAccess } from '../services/account-access.ts';
import type { AuthService } from '../services/auth-service.ts';
import type { MailConnectionValidator } from '../ports/mail/validator.ts';
import type { MailCredentialProbe } from '../ports/security/mail-credential.ts';

import type { SyncStateRepository } from '../ports/mail/sync-state.ts';

/** Everything the application depends on: ports only. The composition root supplies the implementations. */
export interface ApplicationPorts {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly accounts: AccountRepository;
  readonly credentialRecords: CredentialRepository;
  readonly folders: FolderRepository;
  readonly messages: MessageRepository;
  readonly drafts: DraftRepository;
  readonly outbox: OutboxRepository;
  readonly labels: LabelRepository;
  readonly signatures: SignatureRepository;
  readonly templates: TemplateRepository;
  readonly mailbox: MailboxPort;
  readonly blobs: BlobStorage;
  readonly events: EventBus;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly hasher: PasswordHasher;
  readonly sessionSecrets: SessionSecrets;
  readonly loginLimiter: LoginRateLimiter;
  readonly crypto: CryptoPort;
  readonly transactions: UnitOfWork;
  readonly connectionValidator?: MailConnectionValidator;
  readonly credentialProbe?: MailCredentialProbe;
  readonly syncState?: SyncStateRepository;
}

export interface UseCaseDeps extends ApplicationPorts {
  readonly access: AccountAccess;
  readonly auth: AuthService;
  /** Write-only view of the credential vault: use cases can never read a credential back. */
  readonly credentials: MailCredentialWriter;
}

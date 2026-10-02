import {
  MemoryAccountRepository,
  MemoryDraftRepository,
  MemoryFolderRepository,
  MemoryLabelRepository,
  MemoryMessageRepository,
  MemoryOutboxRepository,
  MemorySignatureRepository,
  MemoryTemplateRepository,
} from './memory-repositories.ts';
import { MemoryBlobStorage } from './memory-blob-storage.ts';
import { MemoryMailStore } from './memory-mail-store.ts';
import { MemoryStore } from './memory-store.ts';
import { MemoryUnitOfWork } from './memory-unit-of-work.ts';
import { MemoryCredentialRepository, MemorySessionRepository, MemoryUserRepository } from './memory-security-repositories.ts';

import { MemorySyncStateRepository } from './memory-sync-state.ts';
import { SystemClock } from '../clock/system-clock.ts';
import type { Clock } from '../../application/index.ts';

/** All in-memory repositories over one shared, non-durable store. */
export function createMemoryPersistence(clock: Clock = new SystemClock()) {
  const store = new MemoryStore();
  return {
    store,
    accounts: new MemoryAccountRepository(store),
    folders: new MemoryFolderRepository(store),
    messages: new MemoryMessageRepository(store),
    drafts: new MemoryDraftRepository(store),
    outbox: new MemoryOutboxRepository(store),
    labels: new MemoryLabelRepository(store),
    signatures: new MemorySignatureRepository(store),
    templates: new MemoryTemplateRepository(store),
    blobs: new MemoryBlobStorage(),
    users: new MemoryUserRepository(),
    sessions: new MemorySessionRepository(),
    credentialRecords: new MemoryCredentialRepository(),
    transactions: new MemoryUnitOfWork(),
    mailStore: new MemoryMailStore(store),
    syncState: new MemorySyncStateRepository(clock),
  };
}
export type MemoryPersistence = ReturnType<typeof createMemoryPersistence>;
export { MemoryMailStore } from './memory-mail-store.ts';
export { MemoryLoginRateLimiter } from './memory-login-rate-limiter.ts';
export { MemoryCredentialRepository, MemorySessionRepository, MemoryUserRepository } from './memory-security-repositories.ts';
export { MemoryBlobStorage } from './memory-blob-storage.ts';
export { MemoryStore } from './memory-store.ts';

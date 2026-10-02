/**
 * COMPOSITION ROOT — the one place where implementations are chosen and wired.
 *
 *   config + secrets ──▶ persistence + adapters ──▶ application ports ──▶ use cases/services ──▶ (HTTP, in app.ts)
 *
 * Routes never construct anything; use cases only see ports. Swapping storage (SQLite → PostgreSQL), mail (unavailable →
 * IMAP/SMTP) or a key source (environment → KMS) is a change to this file, not to the use cases or routes. Tests pass
 * `persistence` and/or `ports` to replace things.
 *
 * CURRENT WIRING
 *   users, sessions, accounts, credential records, folders, messages, drafts, outbox, labels, signatures, templates
 *                    → SQLite (`openPersistence`) whenever `config.database.path` is set — always in development and
 *                      production; in-memory only when no path is configured (NODE_ENV=test), for fast application tests
 *   transactions     → SQLite unit of work (real atomicity) / in-memory passthrough
 *   attachment bytes → in-memory placeholder (blob storage is a later phase; only METADATA is durable)
 *   passwords        → Argon2id                 sessions → random secret + SHA-256 fingerprint, server-side records
 *   mail credentials → AES-256-GCM, keys from configuration (a throw-away key only outside production)
 *   login throttling → in-memory, single instance   mailbox → unavailable (no IMAP yet)   events → in-process bus
 */
import { createApplication } from './application/index.ts';
import type { ApplicationPorts, ApplicationServices, ImapProvider, MailboxPort, SmtpProvider } from './application/index.ts';
import type { MailStoreWriter } from './application/ports/repositories/mail-store.ts';
import { createCredentialVault } from './application/services/credential-vault.ts';
import type { ServerConfig, ServerSecrets } from './config/index.ts';
import { SystemClock } from './infrastructure/clock/system-clock.ts';
import { AesGcmCrypto } from './infrastructure/crypto/aes-gcm-crypto.ts';
import { ConfiguredKeyProvider, EphemeralKeyProvider } from './infrastructure/crypto/key-provider.ts';
import type { KeyProvider } from './infrastructure/crypto/key-provider.ts';
import { InMemoryEventBus } from './infrastructure/events/in-memory-event-bus.ts';
import { UuidIdGenerator } from './infrastructure/ids/uuid-id-generator.ts';
import { RealMailConnectionValidator } from './infrastructure/mail/connection-validator.ts';
import { RealMailCredentialProbe, TransientCredentialResolver } from './infrastructure/mail/credential-probe.ts';
import { ImapflowAdapter } from './infrastructure/mail/imapflow-adapter.ts';
import { NodemailerAdapter } from './infrastructure/mail/nodemailer-adapter.ts';
import { RealMailbox } from './infrastructure/mail/real-mailbox.ts';
import { SanitizeHtmlAdapter } from './infrastructure/mail/sanitize-html-adapter.ts';
import { UnavailableMailbox } from './infrastructure/mail/unavailable-mailbox.ts';
import { MemoryLoginRateLimiter, createMemoryPersistence } from './infrastructure/memory/index.ts';
import { DefaultNetworkSecurityPolicy } from './infrastructure/security/network-security.ts';
import { Argon2PasswordHasher } from './infrastructure/security/argon2-password-hasher.ts';
import { NodeSessionSecrets } from './infrastructure/security/node-session-secrets.ts';
import { openSqlite } from './infrastructure/sqlite/index.ts';
import type { AppDependencies } from './app.ts';

import { RealMailSender } from './infrastructure/mail/real-mail-sender.ts';
import { SyncEngine } from './application/services/sync-engine.ts';
import { OutboxWorker } from './application/services/outbox-worker.ts';

export type PortOverrides = Partial<ApplicationPorts>;

/** The persistence ports plus their owner: whatever opens a database also closes it. */
export type Persistence = Pick<
  ApplicationPorts,
  'users' | 'sessions' | 'accounts' | 'credentialRecords' | 'folders' | 'messages' | 'drafts' | 'outbox' | 'labels' | 'signatures' | 'templates' | 'blobs' | 'transactions' | 'syncState'
> & { readonly mailStore?: MailStoreWriter; readonly close?: () => Promise<void> };

export interface OpenedPersistence extends Persistence {
  readonly kind: 'sqlite' | 'memory';
  /** Migration versions applied by this startup (SQLite only). */
  readonly migrationsApplied: readonly number[];
}

/**
 * Opens the configured persistence. Startup order — each step must succeed before the next, and on ANY failure the caller
 * must not start HTTP: open SQLite → PRAGMAs verified → identity check → migrations → repositories.
 */
export async function openPersistence(config: ServerConfig, clock: ApplicationPorts['clock'] = new SystemClock()): Promise<OpenedPersistence> {
  if (config.database.path === null) {
    if (config.nodeEnv === 'production') throw new Error('refusing to start: no database configured');
    return { ...createMemoryPersistence(), kind: 'memory', migrationsApplied: [] };
  }
  const sqlite = await openSqlite({
    path: config.database.path,
    busyTimeoutMs: config.database.busyTimeoutMs,
    clock,
    createDirectory: config.database.createDirectory,
  });
  return { ...sqlite, kind: 'sqlite', migrationsApplied: sqlite.migration.applied };
}

export interface Composition extends AppDependencies {
  /** Internal capabilities for the process owner (user administration, credential resolver, session revocation, sync, outbox). NOT for HTTP. */
  readonly services: ApplicationServices & {
    readonly syncEngine?: SyncEngine;
    readonly outboxWorker?: OutboxWorker;
  };
  /** Startup notes worth logging (never contain secrets). */
  readonly warnings: readonly string[];
}

function keyProviderFor(config: ServerConfig, secrets: ServerSecrets, warnings: string[]): KeyProvider {
  if (secrets.credentialKeys !== null) return new ConfiguredKeyProvider(secrets.credentialKeys);
  // Config validation already rejects a production config without keys; this is the second lock.
  if (config.nodeEnv === 'production') throw new Error('refusing to start: no credential encryption key configured');
  warnings.push('CREDENTIAL_ENCRYPTION_KEYS is not set: using a throw-away in-process key. Stored credentials will not be readable after a restart (development/test only).');
  return new EphemeralKeyProvider();
}

export interface MailIntegrationOptions {
  readonly enabled?: boolean;
  readonly allowPrivateNetworks?: boolean;
  readonly allowSelfSignedTls?: boolean;
  readonly imap?: ImapProvider;
  readonly smtp?: SmtpProvider;
  readonly validateOnAccountSave?: boolean;
}

export interface ComposeOptions {
  readonly secrets?: ServerSecrets;
  readonly persistence?: Persistence;
  readonly ports?: PortOverrides;
  readonly mail?: MailIntegrationOptions;
}

export function compose(config: ServerConfig, options: ComposeOptions = {}): Composition {
  const warnings: string[] = [];
  const overrides = options.ports ?? {};
  const persistence: Persistence = options.persistence ?? createMemoryPersistence();
  const clock = overrides.clock ?? new SystemClock();
  const ids = overrides.ids ?? new UuidIdGenerator();
  const events = overrides.events ?? new InMemoryEventBus();
  const crypto = overrides.crypto ?? new AesGcmCrypto(keyProviderFor(config, options.secrets ?? { credentialKeys: null }, warnings));

  let mailboxPort: MailboxPort = overrides.mailbox ?? new UnavailableMailbox();
  let connectionValidator = overrides.connectionValidator;
  let credentialProbe = overrides.credentialProbe;
  let syncEngine: SyncEngine | undefined;
  let outboxWorker: OutboxWorker | undefined;

  if (options.mail?.enabled && !overrides.mailbox) {
    const imapProvider =
      options.mail.imap ??
      new ImapflowAdapter({
        credentials: {
          withCredentialForMailAdapter: (account, use) =>
            createCredentialVault({
              records: persistence.credentialRecords,
              crypto,
              clock,
              transactions: persistence.transactions,
            }).withCredentialForMailAdapter(account, use),
        },
        security: new DefaultNetworkSecurityPolicy({
          allowPrivateNetworks: options.mail.allowPrivateNetworks,
        }),
        sanitizer: new SanitizeHtmlAdapter(),
        ids,
        allowSelfSignedTls: options.mail.allowSelfSignedTls,
      });

    const smtpProvider =
      options.mail.smtp ??
      new NodemailerAdapter({
        credentials: {
          withCredentialForMailAdapter: (account, use) =>
            createCredentialVault({
              records: persistence.credentialRecords,
              crypto,
              clock,
              transactions: persistence.transactions,
            }).withCredentialForMailAdapter(account, use),
        },
        security: new DefaultNetworkSecurityPolicy({
          allowPrivateNetworks: options.mail.allowPrivateNetworks,
        }),
        allowSelfSignedTls: options.mail.allowSelfSignedTls,
      });

    if (persistence.mailStore) {
      if (persistence.syncState) {
        syncEngine = new SyncEngine({
          imap: imapProvider,
          mailStore: persistence.mailStore,
          folders: persistence.folders,
          syncState: persistence.syncState,
          events,
          clock,
          ids,
          transactions: persistence.transactions,
        });
      }

      outboxWorker = new OutboxWorker({
        outbox: persistence.outbox,
        drafts: persistence.drafts,
        accounts: persistence.accounts,
        folders: persistence.folders,
        sender: new RealMailSender(smtpProvider),
        mailStore: persistence.mailStore,
        events,
        clock,
        ids,
        transactions: persistence.transactions,
      });

      mailboxPort = new RealMailbox({
        imap: imapProvider,
        mailStore: persistence.mailStore,
        folders: persistence.folders,
        messages: persistence.messages,
        transactions: persistence.transactions,
        events,
        clock,
        ids,
        syncEngine,
      });
    }

    // Mailbox sign-in proves a credential that is not stored yet. Only with the real adapters: injected providers
    // (tests) resolve credentials themselves and bring their own probe through `ports.credentialProbe`.
    if (!credentialProbe && !options.mail.imap && !options.mail.smtp) {
      const resolver = new TransientCredentialResolver();
      const security = new DefaultNetworkSecurityPolicy({ allowPrivateNetworks: options.mail.allowPrivateNetworks });
      credentialProbe = new RealMailCredentialProbe(
        resolver,
        new ImapflowAdapter({ credentials: resolver, security, sanitizer: new SanitizeHtmlAdapter(), ids, allowSelfSignedTls: options.mail.allowSelfSignedTls }),
        new NodemailerAdapter({ credentials: resolver, security, allowSelfSignedTls: options.mail.allowSelfSignedTls }),
        ids,
      );
    }

    if (options.mail.validateOnAccountSave || overrides.connectionValidator) {
      connectionValidator = overrides.connectionValidator ?? new RealMailConnectionValidator(imapProvider, smtpProvider);
    }
  }

  const ports: ApplicationPorts = {
    users: persistence.users,
    sessions: persistence.sessions,
    accounts: persistence.accounts,
    credentialRecords: persistence.credentialRecords,
    folders: persistence.folders,
    messages: persistence.messages,
    drafts: persistence.drafts,
    outbox: persistence.outbox,
    labels: persistence.labels,
    signatures: persistence.signatures,
    templates: persistence.templates,
    blobs: persistence.blobs,
    transactions: persistence.transactions,
    mailbox: mailboxPort,
    events,
    clock,
    ids,
    hasher: new Argon2PasswordHasher(),
    sessionSecrets: new NodeSessionSecrets(),
    loginLimiter: new MemoryLoginRateLimiter(clock, config.loginLimits),
    crypto,
    connectionValidator,
    credentialProbe,
    syncState: persistence.syncState,
    ...overrides,
  };

  const { useCases, services } = createApplication(ports, config);
  return {
    config,
    useCases,
    clock: ports.clock,
    services: {
      ...services,
      syncEngine,
      outboxWorker,
    },
    warnings,
    // Only resources that exist are closed. HTTP has already drained when this runs (`app.close()` calls it last).
    shutdown: async () => {
      await ports.events.close();
      await persistence.close?.(); // the database connection: after in-flight requests, WAL checkpointed on close
    },
  };
}

import { ImapFlow } from 'imapflow';
import type { ImapFlowOptions } from 'imapflow';
import type { AuthorizedAccount } from '../../application/context/authorized-account.ts';
import type { IdGenerator } from '../../application/ports/ids/id-generator.ts';
import type { HtmlSanitizer } from '../../application/ports/mail/html-sanitizer.ts';
import type { ImapFetchOptions, ImapMessageFlagsChange, ImapProvider } from '../../application/ports/mail/imap-provider.ts';
import type { ProviderFolderRef, StoredFolder, StoredMessage } from '../../application/ports/repositories/mail-store.ts';
import type { MailCredential, MailCredentialResolver } from '../../application/ports/security/mail-credential.ts';
import type { NetworkSecurityPolicy } from '../security/network-security.ts';
import { normalizeImapError } from './imap-errors.ts';
import { mapImapFlags, mapImapMailboxToStoredFolder } from './imap-mapping.ts';
import { parseMimeMessage } from './mime-parser.ts';

export interface ImapFetchedMessage {
  readonly uid: number;
  readonly flags?: Set<string> | readonly string[];
  readonly modseq?: bigint | number;
  readonly envelope?: {
    readonly subject?: string;
    readonly messageId?: string;
    readonly inReplyTo?: string;
    readonly from?: readonly { readonly name?: string; readonly address?: string }[];
    readonly to?: readonly { readonly name?: string; readonly address?: string }[];
    readonly cc?: readonly { readonly name?: string; readonly address?: string }[];
    readonly bcc?: readonly { readonly name?: string; readonly address?: string }[];
    readonly date?: Date | string;
  };
  readonly source?: Buffer;
}

export interface ImapClientInstance {
  connect(): Promise<unknown>;
  logout(): Promise<unknown>;
  list(): Promise<unknown>;
  status(path: string, query: { messages?: boolean; uidValidity?: boolean; uidNext?: boolean; highestModseq?: boolean }): Promise<unknown>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  download(sequence: string, part?: string, options?: { uid?: boolean }): Promise<unknown>;
  messageFlagsAdd(range: string | number[], flags: string[], options?: { uid?: boolean }): Promise<unknown>;
  messageFlagsRemove(range: string | number[], flags: string[], options?: { uid?: boolean }): Promise<unknown>;
  fetch(sequence: string, query: Record<string, unknown>, options?: { uid?: boolean; changedSince?: bigint | number }): AsyncIterable<unknown>;
  search(query: Record<string, unknown>, options?: { uid?: boolean }): Promise<number[] | false | undefined>;
}

export interface ImapflowAdapterOptions {
  readonly credentials: MailCredentialResolver;
  readonly security: NetworkSecurityPolicy;
  readonly sanitizer: HtmlSanitizer;
  readonly ids: IdGenerator;
  readonly connectionTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly allowSelfSignedTls?: boolean;
  /** Injectable client factory for unit/integration testing without network sockets */
  readonly clientFactory?: (options: ImapFlowOptions) => ImapClientInstance;
}

export class ImapflowAdapter implements ImapProvider {
  private readonly credentials: MailCredentialResolver;
  private readonly security: NetworkSecurityPolicy;
  private readonly sanitizer: HtmlSanitizer;
  private readonly ids: IdGenerator;
  private readonly connectionTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly allowSelfSignedTls: boolean;
  private readonly clientFactory: (options: ImapFlowOptions) => ImapClientInstance;

  constructor(options: ImapflowAdapterOptions) {
    this.credentials = options.credentials;
    this.security = options.security;
    this.sanitizer = options.sanitizer;
    this.ids = options.ids;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 30_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.allowSelfSignedTls = options.allowSelfSignedTls ?? false;
    this.clientFactory = options.clientFactory ?? ((opts) => new ImapFlow(opts));
  }

  private async createConnectedClient<T>(account: AuthorizedAccount, use: (client: ImapClientInstance, creds: MailCredential) => Promise<T>): Promise<T> {
    return this.credentials.withCredentialForMailAdapter(account, async (credential) => {
      // 1. SSRF and host/port validation
      const endpoint = credential.imap;
      await this.security.validateEndpoint(endpoint.host, endpoint.port);

      // 2. Client configuration
      const isSsl = endpoint.security === 'ssl';
      const client = this.clientFactory({
        host: endpoint.host,
        port: endpoint.port,
        secure: isSsl,
        auth: {
          user: credential.username,
          pass: credential.password,
        },
        tls: {
          rejectUnauthorized: !this.allowSelfSignedTls,
        },
        connectionTimeout: this.connectionTimeoutMs,
        greetingTimeout: Math.min(15_000, this.connectionTimeoutMs),
        socketTimeout: this.commandTimeoutMs,
        logger: false, // NEVER log credentials or raw protocol lines
      });

      try {
        await client.connect();
        return await use(client, credential);
      } catch (err) {
        throw normalizeImapError(err, 'imap.connect');
      } finally {
        try {
          await client.logout();
        } catch {
          // ignore disconnect errors
        }
      }
    });
  }

  async testConnection(account: AuthorizedAccount): Promise<void> {
    await this.createConnectedClient(account, async () => {
      // successful connection and login in createConnectedClient verifies the credentials
    });
  }

  async listMailboxes(account: AuthorizedAccount): Promise<readonly StoredFolder[]> {
    return this.createConnectedClient(account, async (client) => {
      try {
        const mailboxes = ((await client.list()) as readonly Record<string, unknown>[]) ?? [];
        const stored: StoredFolder[] = [];

        for (const mb of mailboxes) {
          const folderId = this.ids.next();
          const mbStatus = mb['status'] as Record<string, unknown> | undefined;
          stored.push(
            mapImapMailboxToStoredFolder(folderId, {
              path: String(mb['path'] ?? ''),
              delimiter: typeof mb['delimiter'] === 'string' ? mb['delimiter'] : '/',
              specialUse: typeof mb['specialUse'] === 'string' ? mb['specialUse'] : undefined,
              uidValidity:
                (mb['uidValidity'] as number | bigint | undefined) != null
                  ? Number(mb['uidValidity'])
                  : (mbStatus?.['uidValidity'] as number | bigint | undefined) != null
                    ? Number(mbStatus?.['uidValidity'])
                    : undefined,
              uidNext:
                (mb['uidNext'] as number | bigint | undefined) != null
                  ? Number(mb['uidNext'])
                  : (mbStatus?.['uidNext'] as number | bigint | undefined) != null
                    ? Number(mbStatus?.['uidNext'])
                    : undefined,
              highestModseq:
                (mb['highestModseq'] as number | bigint | undefined) ??
                (mbStatus?.['highestModseq'] as number | bigint | undefined),
            }),
          );
        }

        return stored;
      } catch (err) {
        throw normalizeImapError(err, 'imap.listMailboxes');
      }
    });
  }

  async inspectMailbox(account: AuthorizedAccount, path: string): Promise<ProviderFolderRef | null> {
    return this.createConnectedClient(account, async (client) => {
      try {
        const status = (await client.status(path, {
          messages: true,
          uidValidity: true,
          uidNext: true,
          highestModseq: true,
        })) as Record<string, unknown> | null | undefined;

        if (!status) return null;

        return {
          path,
          delimiter: '/',
          uidValidity: status['uidValidity'] != null ? Number(status['uidValidity']) : null,
          uidNext: status['uidNext'] != null ? Number(status['uidNext']) : null,
          highestModSeq: status['highestModseq'] != null ? Number(status['highestModseq']) : null,
          totalCount: status['messages'] != null ? Number(status['messages']) : null,
        };
      } catch (err) {
        throw normalizeImapError(err, 'imap.inspectMailbox');
      }
    });
  }

  async fetchMessages(
    account: AuthorizedAccount,
    folderId: string,
    path: string,
    options: ImapFetchOptions = {},
  ): Promise<readonly StoredMessage[]> {
    return this.createConnectedClient(account, async (client) => {
      try {
        const lock = await client.getMailboxLock(path);
        try {
          // Determine UID query range
          let sequence = '1:*';
          if (options.uids && options.uids.length > 0) {
            sequence = options.uids.join(',');
          } else if (options.minUid !== undefined && options.maxUid !== undefined) {
            sequence = `${options.minUid}:${options.maxUid}`;
          } else if (options.minUid !== undefined) {
            sequence = `${options.minUid}:*`;
          }

          const messagesGenerator = client.fetch(
            sequence,
            {
              uid: true,
              flags: true,
              envelope: true,
              bodyStructure: true,
              source: true,
            },
            { uid: true },
          );

          const storedMessages: StoredMessage[] = [];
          let count = 0;
          const limit = options.limit ?? 50;

          for await (const rawMsg of messagesGenerator) {
            const msg = rawMsg as ImapFetchedMessage;
            if (count >= limit) break;

            const flagsMapping = mapImapFlags(msg.flags ?? []);
            let parsedMime = null;
            if (msg.source) {
              parsedMime = await parseMimeMessage(msg.source, {
                sanitizer: this.sanitizer,
                generateId: () => this.ids.next(),
              });
            }

            const messageId = this.ids.next();
            const threadId = this.ids.next(); // Phase 6 initial thread id

            const from = parsedMime?.from ?? {
              email: msg.envelope?.from?.[0]?.address ?? '',
              name: msg.envelope?.from?.[0]?.name ?? '',
            };

            const to = parsedMime?.to ?? (msg.envelope?.to?.map((t) => ({ email: t.address ?? '', name: t.name ?? '' })) ?? []);
            const cc = parsedMime?.cc ?? (msg.envelope?.cc?.map((c) => ({ email: c.address ?? '', name: c.name ?? '' })) ?? []);
            const bcc = parsedMime?.bcc ?? (msg.envelope?.bcc?.map((b) => ({ email: b.address ?? '', name: b.name ?? '' })) ?? []);

            const subject = parsedMime?.subject ?? msg.envelope?.subject ?? '';
            const preview = parsedMime?.preview ?? '';
            const date = parsedMime?.date ?? (msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : new Date().toISOString());

            const messageDto = {
              id: messageId,
              accountId: account.id,
              folderId,
              threadId,
              from,
              to: [...to],
              cc: [...cc],
              bcc: [...bcc],
              subject,
              preview,
              date,
              seen: flagsMapping.seen,
              pinned: flagsMapping.pinned,
              answered: flagsMapping.answered,
              forwarded: flagsMapping.forwarded,
              draft: flagsMapping.draft,
              hasAttachments: (parsedMime?.attachments.length ?? 0) > 0,
              labels: [...flagsMapping.customLabels],
              outbox: { state: 'none' as const },
              body: {
                text: parsedMime?.textBody ?? null,
                html: parsedMime?.htmlBody ?? null,
              },
              attachments: (parsedMime?.attachments ?? []).map((att) => ({
                id: att.id,
                messageId,
                fileName: att.fileName,
                mimeType: att.mimeType,
                sizeBytes: att.sizeBytes,
                isInline: att.isInline,
              })),
            };

            const providerRef = {
              uid: msg.uid ?? null,
              uidValidity: null,
              modSeq: msg.modseq != null ? Number(msg.modseq) : null,
              messageIdHeader: parsedMime?.messageIdHeader ?? msg.envelope?.messageId ?? null,
              inReplyTo: parsedMime?.inReplyTo ?? msg.envelope?.inReplyTo ?? null,
              references: parsedMime?.references ?? null,
            };

            storedMessages.push({
              message: messageDto,
              provider: providerRef,
              serverDeleted: flagsMapping.serverDeleted,
              attachmentParts: parsedMime?.attachmentParts,
            });

            count++;
          }

          return storedMessages;
        } finally {
          lock.release();
        }
      } catch (err) {
        throw normalizeImapError(err, 'imap.fetchMessages');
      }
    });
  }

  async updateFlags(
    account: AuthorizedAccount,
    path: string,
    uids: readonly number[],
    operations: {
      add?: readonly string[];
      remove?: readonly string[];
    },
  ): Promise<void> {
    if (uids.length === 0) return;

    await this.createConnectedClient(account, async (client) => {
      try {
        const lock = await client.getMailboxLock(path);
        try {
          const sequence = uids.join(',');
          if (operations.add && operations.add.length > 0) {
            await client.messageFlagsAdd(sequence, [...operations.add], { uid: true });
          }
          if (operations.remove && operations.remove.length > 0) {
            await client.messageFlagsRemove(sequence, [...operations.remove], { uid: true });
          }
        } finally {
          lock.release();
        }
      } catch (err) {
        throw normalizeImapError(err, 'imap.updateFlags');
      }
    });
  }

  async fetchFlags(
    account: AuthorizedAccount,
    path: string,
    options: {
      readonly uids?: readonly number[];
      readonly changedSince?: number;
    } = {},
  ): Promise<readonly ImapMessageFlagsChange[]> {
    return this.createConnectedClient(account, async (client) => {
      try {
        const lock = await client.getMailboxLock(path);
        try {
          let sequence = '1:*';
          if (options.uids && options.uids.length > 0) {
            sequence = options.uids.join(',');
          }
          const fetchOpts: { uid?: boolean; changedSince?: bigint } = { uid: true };
          if (options.changedSince != null) {
            fetchOpts.changedSince = BigInt(options.changedSince);
          }
          const gen = client.fetch(sequence, { uid: true, flags: true, modseq: true }, fetchOpts);
          const results: ImapMessageFlagsChange[] = [];
          for await (const rawMsg of gen) {
            const msg = rawMsg as { uid: number; flags?: Iterable<string>; modseq?: bigint | number };
            const mapped = mapImapFlags(msg.flags ?? []);
            results.push({
              uid: msg.uid,
              modSeq: msg.modseq != null ? Number(msg.modseq) : null,
              flags: {
                seen: mapped.seen,
                pinned: mapped.pinned,
                answered: mapped.answered,
                forwarded: mapped.forwarded,
                serverDeleted: mapped.serverDeleted,
              },
            });
          }
          return results;
        } finally {
          lock.release();
        }
      } catch (err) {
        throw normalizeImapError(err, 'imap.fetchFlags');
      }
    });
  }

  async searchUids(account: AuthorizedAccount, path: string): Promise<readonly number[]> {
    return this.createConnectedClient(account, async (client) => {
      try {
        const lock = await client.getMailboxLock(path);
        try {
          const rawUids = await client.search({ all: true }, { uid: true });
          return Array.isArray(rawUids) ? rawUids.map(Number) : [];
        } finally {
          lock.release();
        }
      } catch (err) {
        throw normalizeImapError(err, 'imap.searchUids');
      }
    });
  }
}

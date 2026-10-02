import { describe, expect, it } from 'vitest';
import { grantAccountAccess } from '../../application/context/authorized-account.ts';
import type { ImapProvider } from '../../application/ports/mail/imap-provider.ts';
import type { StoredFolder, StoredMessage } from '../../application/ports/repositories/mail-store.ts';
import { SystemClock } from '../clock/system-clock.ts';
import { InMemoryEventBus } from '../events/in-memory-event-bus.ts';
import { UuidIdGenerator } from '../ids/uuid-id-generator.ts';
import { openSqlite } from '../sqlite/index.ts';
import { RealMailbox } from './real-mailbox.ts';

describe('RealMailbox with SqliteMailStore integration', () => {
  const account = grantAccountAccess({ id: 'acc-test', userId: 'usr-test', email: 'user@example.com' });
  const clock = new SystemClock();
  const ids = new UuidIdGenerator();
  const events = new InMemoryEventBus();

  it('syncs folders and messages into SQLite via MailStoreWriter', async () => {
    const sqlite = await openSqlite({
      path: ':memory:',
      clock,
      createDirectory: false,
    });

    // Create user and account in DB first
    await sqlite.users.create({
      id: account.userId,
      identifier: 'testuser',
      passwordHash: 'dummyhash',
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
    await sqlite.accounts.create(account.userId, {
      id: account.id,
      email: account.email,
      displayName: 'Test User',
      supportsServerLabels: null,
      sync: { status: 'idle', lastSyncAt: null },
    });

    const mockStoredFolders: StoredFolder[] = [
      {
        id: 'f-inbox',
        name: 'Gelen Kutusu',
        role: 'inbox',
        sortOrder: 0,
        provider: {
          path: 'INBOX',
          delimiter: '/',
          uidValidity: 1000,
          uidNext: 10,
          highestModSeq: 500,
        },
      },
      {
        id: 'f-sent',
        name: 'Gönderilenler',
        role: 'sent',
        sortOrder: 10,
        provider: {
          path: 'Sent',
          delimiter: '/',
          uidValidity: 1001,
          uidNext: 5,
          highestModSeq: 200,
        },
      },
    ];

    const mockStoredMessages: StoredMessage[] = [
      {
        message: {
          id: 'msg-1',
          accountId: account.id,
          folderId: 'f-inbox',
          threadId: 'th-1',
          from: { email: 'sender@example.com', name: 'Sender' },
          to: [{ email: account.email, name: 'Test User' }],
          cc: [],
          bcc: [],
          subject: 'Hos Geldiniz',
          preview: 'Kaydet uygulamasina hos geldiniz.',
          date: new Date().toISOString(),
          seen: false,
          pinned: true,
          answered: false,
          forwarded: false,
          draft: false,
          hasAttachments: false,
          labels: [],
          outbox: { state: 'none' },
          body: {
            text: 'Kaydet uygulamasina hos geldiniz.',
            html: { content: '<p>Kaydet uygulamasina hos geldiniz.</p>', sanitized: true },
          },
          attachments: [],
        },
        provider: {
          uid: 101,
          uidValidity: 1000,
          modSeq: 501,
          messageIdHeader: '<welcome-101@example.com>',
          inReplyTo: null,
          references: null,
        },
      },
    ];

    const fakeImap: ImapProvider = {
      testConnection: async () => {},
      listMailboxes: async () => mockStoredFolders,
      inspectMailbox: async () => null,
      fetchMessages: async () => mockStoredMessages,
      updateFlags: async () => {},
      fetchFlags: async () => [],
      searchUids: async () => [],
    };

    const mailbox = new RealMailbox({
      imap: fakeImap,
      mailStore: sqlite.mailStore,
      folders: sqlite.folders,
      messages: sqlite.messages,
      transactions: sqlite.transactions,
      events,
      clock,
      ids,
    });

    const status = await mailbox.requestSync(account);
    expect(status).toBe('started');

    // Read back via FolderRepository
    const folders = await sqlite.folders.listByAccount(account);
    expect(folders).toHaveLength(2);
    expect(folders.find((f) => f.role === 'inbox')?.name).toBe('Gelen Kutusu');

    // Read back via MessageRepository
    const readMessage = await sqlite.messages.findOwned(account.userId, 'msg-1');
    expect(readMessage).not.toBeNull();
    expect(readMessage?.id).toBe('msg-1');
    expect(readMessage?.subject).toBe('Hos Geldiniz');
    expect(readMessage?.pinned).toBe(true);
    expect(readMessage?.body.html?.sanitized).toBe(true);

    // Verify provider ref is present in mailStore internal lookups
    const providerRef = await sqlite.mailStore.providerRefOfMessage(account, 'msg-1');
    expect(providerRef?.uid).toBe(101);
    expect(providerRef?.modSeq).toBe(501);
    expect(providerRef?.messageIdHeader).toBe('<welcome-101@example.com>');

    // Verify provider ref does NOT leak into public DTO
    expect(readMessage).not.toHaveProperty('provider');
    expect(readMessage).not.toHaveProperty('uid');

    await sqlite.close();
  });
});

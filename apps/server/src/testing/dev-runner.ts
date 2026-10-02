/**
 * Development Server Runner with Seeded Test Fixtures
 * Used for localhost development and browser verification of Phase 9.
 */
import { startServer } from '../server.ts';
import { IDS } from './fixtures.ts';
import { createTestApplication } from './harness.ts';

async function main(): Promise<void> {
  const app = await createTestApplication({
    env: {
      PORT: '3001',
      NODE_ENV: 'development',
      CORS_ALLOWED_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
    },
    ports: {
      mailbox: {
        requestSync: () => Promise.resolve('started'),
        createFolder: () => Promise.reject(new Error('unused')),
        updateFolder: () => Promise.reject(new Error('unused')),
        deleteFolder: () => Promise.reject(new Error('unused')),
        applyActions: (r) =>
          Promise.resolve({
            appliedIds: r.messageIds,
            failed: [],
            undo: { token: 'u'.repeat(24), expiresAt: '2026-10-01T12:00:00.000Z' },
            affectedFolderIds: [IDS.a1Inbox],
          }),
        undo: () => Promise.resolve({ restored: true, accountId: IDS.a1, folderIds: [IDS.a1Inbox] }),
      },
      connectionValidator: {
        validate: () => Promise.resolve(),
      },
    },
  });

  const server = await startServer(app.config, { credentialKeys: null }, app.composition);
  console.log(`[DevRunner] Kaydet API server listening at ${server.address}`);

  const shutdown = async () => {
    console.log('[DevRunner] Shutting down server...');
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[DevRunner] Failed to start:', error);
  process.exit(1);
});

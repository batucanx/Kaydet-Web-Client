import { afterEach, describe, expect, it } from 'vitest';
import { readCookie } from './middleware/auth-context.ts';
import { startServer } from '../server.ts';
import type { RunningServer } from '../server.ts';
import { IDS } from '../testing/fixtures.ts';
import { SEED_IDENTIFIERS, SEED_PASSWORD, createTestApplication } from '../testing/harness.ts';

let runningServer: RunningServer | undefined;

afterEach(async () => {
  await runningServer?.close();
  runningServer = undefined;
});

describe('Phase 8 — Real Browser -> API -> Fastify Server End-to-End Verification', () => {
  it('verifies the full authentication, CSRF, account isolation, mail retrieval and action lifecycle over a real socket', async () => {
    // 1. Start real Fastify server on dynamic port with real security (Argon2, CSRF, sessions)
    const app = await createTestApplication({
      env: {
        PORT: '0',
        NODE_ENV: 'test',
        CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
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
      },
    });

    runningServer = await startServer(app.config, { credentialKeys: null }, app.composition);
    const baseUrl = `${runningServer.address}/api`;

    // 2. Health & Ready check
    const healthRes = await fetch(`${runningServer.address}/health`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ status: 'ok' });

    const readyRes = await fetch(`${runningServer.address}/ready`);
    expect(readyRes.status).toBe(200);
    expect(await readyRes.json()).toEqual({ status: 'ready' });

    // 3. Initial unauthenticated session check
    const initialSessionRes = await fetch(`${baseUrl}/session`);
    expect(initialSessionRes.status).toBe(200);
    const initialSession = (await initialSessionRes.json()) as { authenticated: boolean; user: null };
    expect(initialSession.authenticated).toBe(false);
    expect(initialSession.user).toBeNull();

    // 4. Unauthorized request fails with 401
    const unauthorizedRes = await fetch(`${baseUrl}/accounts`);
    expect(unauthorizedRes.status).toBe(401);
    const unauthorizedErr = (await unauthorizedRes.json()) as { error: { code: string } };
    expect(unauthorizedErr.error.code).toBe('not_authenticated');

    // 5. Sign in as User A
    const loginRes = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: SEED_IDENTIFIERS.a,
        password: SEED_PASSWORD,
      }),
    });

    expect(loginRes.status).toBe(201);
    const loginBody = (await loginRes.json()) as { authenticated: boolean; user: { id: string } };
    expect(loginBody.authenticated).toBe(true);
    expect(loginBody.user.id).toBeDefined();

    // Verify Set-Cookie header contains HttpOnly session cookie
    const setCookieHeader = loginRes.headers.get('set-cookie');
    expect(setCookieHeader).toBeTruthy();
    expect(setCookieHeader).toContain(app.config.cookie.name);
    expect(setCookieHeader).toContain('HttpOnly');

    const sessionCookieValue = readCookie(setCookieHeader ?? '', app.config.cookie.name);
    expect(sessionCookieValue).toBeTruthy();
    const cookieHeader = `${app.config.cookie.name}=${sessionCookieValue}`;

    // Verify CSRF token returned in header
    const csrfToken = loginRes.headers.get('x-csrf-token');
    expect(csrfToken).toBeTruthy();
    expect(typeof csrfToken).toBe('string');

    // 6. Test CSRF protection on mutating request
    // 6a. Attempt action WITHOUT CSRF token -> 403 Forbidden
    const noCsrfRes = await fetch(`${baseUrl}/messages/actions`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accountId: IDS.a1,
        messageIds: [IDS.m1],
        actions: [{ type: 'markRead' }],
      }),
    });
    expect(noCsrfRes.status).toBe(403);

    // 6b. Attempt action with INVALID CSRF token -> 403 Forbidden
    const invalidCsrfRes = await fetch(`${baseUrl}/messages/actions`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        'x-csrf-token': 'bad-token-xyz',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accountId: IDS.a1,
        messageIds: [IDS.m1],
        actions: [{ type: 'markRead' }],
      }),
    });
    expect(invalidCsrfRes.status).toBe(403);

    // 7. Load real accounts with valid session
    const accountsRes = await fetch(`${baseUrl}/accounts`, {
      headers: { cookie: cookieHeader },
    });
    expect(accountsRes.status).toBe(200);
    const accountsData = (await accountsRes.json()) as { items: Array<{ id: string; email: string }> };
    expect(accountsData.items.length).toBeGreaterThan(0);
    const accountA = accountsData.items[0];
    expect(accountA.id).toBe(IDS.a1);

    // 8. Load real folders for the account
    const foldersRes = await fetch(`${baseUrl}/accounts/${accountA.id}/folders`, {
      headers: { cookie: cookieHeader },
    });
    expect(foldersRes.status).toBe(200);
    const foldersData = (await foldersRes.json()) as { items: Array<{ id: string; role: string; name: string }> };
    expect(foldersData.items.length).toBeGreaterThan(0);
    const inboxFolder = foldersData.items.find((f) => f.role === 'inbox');
    expect(inboxFolder).toBeDefined();

    // 9. Load message list for the folder
    const messagesRes = await fetch(
      `${baseUrl}/accounts/${accountA.id}/messages?scope=folder&folderId=${inboxFolder?.id}&limit=10`,
      {
        headers: { cookie: cookieHeader },
      },
    );
    expect(messagesRes.status).toBe(200);
    const messagesData = (await messagesRes.json()) as {
      items: Array<{ id: string; subject: string; seen: boolean }>;
      nextCursor: string | null;
    };
    expect(messagesData.items.length).toBeGreaterThan(0);
    const targetMessage = messagesData.items[0];

    // 10. Execute real mutation with valid cookie AND valid CSRF token
    const actionRes = await fetch(`${baseUrl}/messages/actions`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        'x-csrf-token': csrfToken!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accountId: accountA.id,
        messageIds: [targetMessage.id],
        actions: [{ type: 'markRead' }],
      }),
    });
    expect(actionRes.status).toBe(200);
    const actionResult = (await actionRes.json()) as {
      appliedIds: string[];
      failed: unknown[];
    };
    expect(actionResult.appliedIds).toContain(targetMessage.id);
    expect(actionResult.failed).toHaveLength(0);

    // 11. Account isolation: Sign in as User B and verify cross-account protection
    const loginBRes = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: SEED_IDENTIFIERS.b,
        password: SEED_PASSWORD,
      }),
    });
    expect(loginBRes.status).toBe(201);
    const cookieBValue = readCookie(loginBRes.headers.get('set-cookie') ?? '', app.config.cookie.name);
    const cookieBHeader = `${app.config.cookie.name}=${cookieBValue}`;

    // User B tries to access User A's account -> 404 account_not_found (never reveals existence)
    const leakAttemptRes = await fetch(`${baseUrl}/accounts/${accountA.id}/folders`, {
      headers: { cookie: cookieBHeader },
    });
    expect(leakAttemptRes.status).toBe(404);
    const leakErr = (await leakAttemptRes.json()) as { error: { code: string } };
    expect(leakErr.error.code).toBe('account_not_found');

    // 12. Sign out User A
    const logoutRes = await fetch(`${baseUrl}/session`, {
      method: 'DELETE',
      headers: {
        cookie: cookieHeader,
        'x-csrf-token': csrfToken!,
      },
    });
    expect(logoutRes.status).toBe(204);

    // After sign-out, session is revoked; using old cookie gives 401
    const postLogoutRes = await fetch(`${baseUrl}/accounts`, {
      headers: { cookie: cookieHeader },
    });
    expect(postLogoutRes.status).toBe(401);
  });
});

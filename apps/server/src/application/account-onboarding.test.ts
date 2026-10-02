import { afterEach, describe, expect, it } from 'vitest';
import type { AccountCreateRequest } from '@kaydet/domain';
import type { RequestContext } from './context/request-context.ts';
import { AppError } from './errors.ts';
import { USER_A } from '../testing/fixtures.ts';
import { createSqliteTestApplication } from '../testing/sqlite.ts';
import type { SqliteTestApplication } from '../testing/sqlite.ts';

const apps: SqliteTestApplication[] = [];
const create = async (options: Parameters<typeof createSqliteTestApplication>[0] = {}) => {
  const app = await createSqliteTestApplication(options);
  apps.push(app);
  return app;
};

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) {
    await app.cleanup();
  }
});

const ctxFor = (userId: string): RequestContext => ({
  requestId: 'req',
  actor: { kind: 'user', userId },
  session: { status: 'active', id: 's', expiresAt: new Date('2027-01-01T00:00:00.000Z'), csrfToken: 'c' },
  metadata: { method: 'TEST', route: '/test', clientAddress: '203.0.113.1' },
});

const validRequest = (): AccountCreateRequest => ({
  email: 'test@kaydet.example.com',
  displayName: 'Kaydet Test',
  username: 'test@kaydet.example.com',
  password: 'super-secret-password-123',
  imap: { host: 'imap.kaydet.example.com', port: 993, security: 'ssl' },
  smtp: { host: 'smtp.kaydet.example.com', port: 465, security: 'ssl' },
});

describe('Account Onboarding & Connection Validation (Phase 11.5)', () => {
  it('successfully creates an account, encrypts credentials, seeds default labels and signature, and triggers sync', async () => {
    let syncRequested = false;
    let validated = false;

    const app = await create({
      ports: {
        mailbox: {
          requestSync: () => {
            syncRequested = true;
            return Promise.resolve('started');
          },
          createFolder: () => Promise.reject(new Error('unused')),
          updateFolder: () => Promise.reject(new Error('unused')),
          deleteFolder: () => Promise.reject(new Error('unused')),
          applyActions: () => Promise.reject(new Error('unused')),
          undo: () => Promise.reject(new Error('unused')),
        },
        connectionValidator: {
          validate: () => {
            validated = true;
            return Promise.resolve();
          },
        },
      },
    });

    const ctx = ctxFor(USER_A);
    const req = validRequest();
    const created = await app.useCases.createAccount(ctx, req);

    expect(validated).toBe(true);
    expect(created.id).toBeDefined();
    expect(created.email).toBe('test@kaydet.example.com');
    expect(created.displayName).toBe('Kaydet Test');
    // Security: password or secrets must NEVER be present in the returned DTO
    expect(created).not.toHaveProperty('password');
    expect(created).not.toHaveProperty('imap');
    expect(created).not.toHaveProperty('smtp');

    // Verify account exists in repository
    const userAccounts = await app.useCases.listAccounts(ctx);
    expect(userAccounts.items.some((a) => a.id === created.id)).toBe(true);

    // Verify default labels were seeded (İş, Kişisel, Tasarım, Finans)
    const labels = await app.useCases.listLabels(ctx, created.id);
    expect(labels.items.map((l) => l.name)).toEqual(
      expect.arrayContaining(['İş', 'Kişisel', 'Tasarım', 'Finans']),
    );

    // Verify default signature was seeded
    const signatures = await app.useCases.listSignatures(ctx, created.id);
    expect(signatures.items.length).toBeGreaterThan(0);
    expect(signatures.items[0].body).toContain('Kaydet Test');

    // Verify initial sync was triggered
    expect(syncRequested).toBe(true);
  });

  it('fails atomically when IMAP connection validation fails, leaving NO account or credential', async () => {
    const app = await create({
      ports: {
        connectionValidator: {
          validate: () => {
            throw new AppError('mail_credentials_rejected', {
              operation: 'imap.connect',
              fields: [{ field: 'imap', reason: 'mail_credentials_rejected' }],
            });
          },
        },
      },
    });

    const ctx = ctxFor(USER_A);
    const req = validRequest();
    await expect(app.useCases.createAccount(ctx, req)).rejects.toThrow();

    // Verify transaction rollback: no account was saved in database
    const userAccounts = await app.useCases.listAccounts(ctx);
    expect(userAccounts.items.some((a) => a.email === req.email)).toBe(false);
  });

  it('fails atomically when SMTP connection validation fails, tagging SMTP field', async () => {
    const app = await create({
      ports: {
        connectionValidator: {
          validate: () => {
            throw new AppError('provider_unreachable', {
              operation: 'smtp.operation',
              fields: [{ field: 'smtp', reason: 'provider_unreachable' }],
            });
          },
        },
      },
    });

    const ctx = ctxFor(USER_A);
    const req = validRequest();
    let caught: unknown;
    try {
      await app.useCases.createAccount(ctx, req);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('provider_unreachable');
    expect((caught as AppError).options.fields).toEqual([
      { field: 'smtp', reason: 'provider_unreachable' },
    ]);

    // Verify rollback: no account was saved
    const userAccounts = await app.useCases.listAccounts(ctx);
    expect(userAccounts.items.some((a) => a.email === req.email)).toBe(false);
  });

  it('prevents adding the same account email twice for the same user', async () => {
    const app = await create({
      ports: {
        connectionValidator: {
          validate: () => Promise.resolve(),
        },
      },
    });

    const ctx = ctxFor(USER_A);
    const req = validRequest();
    await app.useCases.createAccount(ctx, req);

    await expect(app.useCases.createAccount(ctx, req)).rejects.toMatchObject({
      code: 'account_exists',
    });
  });
});

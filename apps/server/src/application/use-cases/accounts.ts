import type { AccountCreateRequest, AccountDTO, AccountUpdateRequest, SyncResponse } from '@kaydet/domain';
import { AppError, defineUseCase } from '../errors.ts';
import type { RequestContext } from '../context/request-context.ts';
import type { MailCredentialPatch } from '../ports/security/mail-credential.ts';
import type { UseCaseDeps } from './deps.ts';

const sameEmail = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

type Deps = Pick<
  UseCaseDeps,
  | 'access'
  | 'accounts'
  | 'credentials'
  | 'mailbox'
  | 'events'
  | 'ids'
  | 'transactions'
  | 'connectionValidator'
  | 'labels'
  | 'signatures'
>;

export type AccountProvisioner = (ctx: RequestContext, request: AccountCreateRequest, options: { readonly validate: boolean }) => Promise<AccountDTO>;

export function createAccountProvisioner({ access, accounts, credentials, ids, transactions, connectionValidator, labels, signatures }: Pick<Deps, 'access' | 'accounts' | 'credentials' | 'ids' | 'transactions' | 'connectionValidator' | 'labels' | 'signatures'>): AccountProvisioner {
  /**
   * Adds a mail account: metadata through the account repository, credentials ENCRYPTED through the credential
   * writer. With `validate`, tests IMAP/SMTP connectivity and authentication before committing; on provider failure the
   * transaction rolls back so no partial account is saved. (Mailbox sign-in has already proven the credentials.)
   */
  return async function provisionAccount(ctx: RequestContext, request: AccountCreateRequest, options: { readonly validate: boolean }): Promise<AccountDTO> {
    const userId = access.requireUserId(ctx);
    if ((await accounts.listByUser(userId)).some((a) => sameEmail(a.email, request.email))) throw new AppError('account_exists');

    const account: AccountDTO = {
      id: ids.next(),
      email: request.email.trim(),
      displayName: request.displayName,
      supportsServerLabels: null,
      sync: { status: 'idle', lastSyncAt: null },
    };
    // ATOMIC: an account never exists without its encrypted credential. It is created FOR the acting user, then
    // addressed through the normal ownership check.
    await transactions.run(async () => {
      if ((await accounts.listByUser(userId)).some((a) => sameEmail(a.email, request.email))) throw new AppError('account_exists');
      await accounts.create(userId, account);
      const authorized = await access.authorize(ctx, account.id);
      await credentials.save(authorized, { username: request.username, password: request.password, imap: request.imap, smtp: request.smtp });
      if (options.validate && connectionValidator) {
        await connectionValidator.validate(authorized);
      }
      if (labels) {
        const defaults = [
          { name: 'İş', tone: 10 },
          { name: 'Kişisel', tone: 6 },
          { name: 'Tasarım', tone: 12 },
          { name: 'Finans', tone: 3 },
        ];
        for (const d of defaults) {
          await labels.save(authorized, { id: ids.next(), accountId: account.id, name: d.name, tone: d.tone });
        }
      }
      if (signatures && (request.displayName || request.email)) {
        await signatures.save(authorized, {
          id: ids.next(),
          accountId: account.id,
          name: 'Varsayılan',
          body: `<p>Saygılarımla,<br><strong>${request.displayName || request.email}</strong></p>`,
          isDefault: true,
        });
      }
    });
    return account;
  }
}

export function createAccountUseCases({ access, accounts, credentials, mailbox, events, ids, transactions, connectionValidator, labels, signatures }: Deps) {
  const provisionAccount = createAccountProvisioner({ access, accounts, credentials, ids, transactions, connectionValidator, labels, signatures });

  return {
    listAccounts: defineUseCase('accounts.list', async (ctx: RequestContext): Promise<{ items: AccountDTO[] }> => ({
      items: await accounts.listByUser(access.requireUserId(ctx)),
    })),

    /**
     * Adds a mail account: metadata through the account repository, credentials ENCRYPTED through the credential
     * writer. If a connection validator is configured, tests IMAP/SMTP connectivity and authentication before committing.
     * On provider failure, the transaction rolls back so no partial account is saved.
     */
    createAccount: defineUseCase('accounts.create', async (ctx: RequestContext, request: AccountCreateRequest): Promise<AccountDTO> => {
      const userId = access.requireUserId(ctx);
      const account = await provisionAccount(ctx, request, { validate: true });
      events.publish(userId, { type: 'accounts.changed' }); // after the commit
      try {
        const authorized = await access.authorize(ctx, account.id);
        void mailbox.requestSync(authorized).catch(() => {
          // Background sync failure does not fail account creation
        });
      } catch {
        // Ignored
      }
      return account;
    }),

    /** Display name and/or credentials/endpoints. Old and new secrets are never returned or logged. */
    updateAccount: defineUseCase('accounts.update', async (ctx: RequestContext, accountId: string, request: AccountUpdateRequest): Promise<AccountDTO> => {
      const account = await access.authorize(ctx, accountId);
      const credentialPatch: MailCredentialPatch = {
        ...(request.username === undefined ? {} : { username: request.username }),
        ...(request.password === undefined ? {} : { password: request.password }),
        ...(request.imap === undefined ? {} : { imap: request.imap }),
        ...(request.smtp === undefined ? {} : { smtp: request.smtp }),
      };
      // ATOMIC: account metadata and the replaced credential change together.
      const updated = await transactions.run(async () => {
        if (Object.keys(credentialPatch).length > 0) {
          await credentials.update(account, credentialPatch);
          if (connectionValidator) {
            await connectionValidator.validate(account);
          }
        }
        return accounts.update(account, request.displayName === undefined ? {} : { displayName: request.displayName });
      });
      events.publish(account.userId, { type: 'accounts.changed' });
      return updated;
    }),

    deleteAccount: defineUseCase('accounts.delete', async (ctx: RequestContext, accountId: string): Promise<void> => {
      const account = await access.authorize(ctx, accountId);
      await transactions.run(async () => {
        await accounts.remove(account);
        await credentials.remove(account); // no encrypted credential outlives its account
      });
      events.publish(account.userId, { type: 'accounts.changed' });
    }),

    syncAccount: defineUseCase('accounts.sync', async (ctx: RequestContext, accountId: string): Promise<SyncResponse> => {
      const account = await access.authorize(ctx, accountId);
      return { status: await mailbox.requestSync(account) };
    }),
  };
}

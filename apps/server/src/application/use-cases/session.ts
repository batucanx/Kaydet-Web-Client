import type { MailboxSessionCreateRequest, SessionCreateRequest, SessionDTO } from '@kaydet/domain';
import { AppError, defineUseCase } from '../errors.ts';
import { grantAccountAccess } from '../context/authorized-account.ts';
import { mailboxIdentifier } from '../services/identifier.ts';
import { createAccountProvisioner } from './accounts.ts';
import type { RequestContext } from '../context/request-context.ts';
import type { ResolvedSession } from '../services/auth-service.ts';
import type { UseCaseDeps } from './deps.ts';

export interface SessionView {
  readonly session: SessionDTO;
  /** For the `X-CSRF-Token` response header; `null` when signed out. Not part of the contract DTO. */
  readonly csrfToken: string | null;
}

export interface SessionSignIn {
  readonly session: SessionDTO;
  /** The session SECRET for the cookie. Never logged, never in a DTO. */
  readonly token: string;
  readonly expiresAt: Date;
  readonly csrfToken: string;
}

export interface MailboxSessionSignIn extends SessionSignIn {
  /** Whether this sign-in created the mail account (the caller starts its first sync). */
  readonly accountCreated: boolean;
}

export function createSessionUseCases(deps: UseCaseDeps) {
  const { auth, access, accounts, credentials, credentialProbe, events, mailbox } = deps;
  const provisionAccount = createAccountProvisioner(deps);

  return {
    /** Cookie value → who is this. Anonymous callers get `none`/`expired`, never an error. */
    resolveSession: defineUseCase('session.resolve', (token: string | null): Promise<ResolvedSession> => auth.resolve(token)),

    /** Works signed out: answers `authenticated: false`. */
    getSession: defineUseCase('session.get', (ctx: RequestContext): Promise<SessionView> => {
      if (ctx.actor.kind === 'user' && ctx.session.status === 'active') {
        return Promise.resolve({
          session: { authenticated: true, user: { id: ctx.actor.userId }, expiresAt: ctx.session.expiresAt.toISOString() },
          csrfToken: ctx.session.csrfToken,
        });
      }
      return Promise.resolve({ session: { authenticated: false, user: null, expiresAt: null }, csrfToken: null });
    }),

    /** Kaydet sign-in (not a mailbox login). Always issues a NEW session and revokes any presented one. */
    createSession: defineUseCase('session.create', async (ctx: RequestContext, request: SessionCreateRequest): Promise<SessionSignIn> => {
      const issued = await auth.login({
        identifier: request.identifier,
        password: request.password,
        clientAddress: ctx.metadata.clientAddress,
        replacingSessionId: ctx.session.status === 'active' ? ctx.session.id : null,
      });
      return {
        session: { authenticated: true, user: { id: issued.userId }, expiresAt: issued.expiresAt.toISOString() },
        token: issued.token,
        expiresAt: issued.expiresAt,
        csrfToken: issued.csrfToken,
      };
    }),

    /**
     * Mailbox sign-in (web login screen): the mail provider is the authority. See `AuthService.loginWithMailbox`.
     * The Kaydet user is keyed by address + IMAP host and has no password of its own.
     */
    createMailboxSession: defineUseCase('session.createMailbox', async (ctx: RequestContext, request: MailboxSessionCreateRequest): Promise<MailboxSessionSignIn> => {
      if (!credentialProbe) throw new AppError('service_unavailable');
      const email = request.email.trim();
      const identifier = mailboxIdentifier(email, request.imap.host);
      if (identifier === null) throw new AppError('invalid_request', { fields: [{ field: 'email', reason: 'invalid' }] });

      let accountCreated = false;
      const issued = await auth.loginWithMailbox({
        identifier,
        clientAddress: ctx.metadata.clientAddress,
        replacingSessionId: ctx.session.status === 'active' ? ctx.session.id : null,
        verify: () => credentialProbe.verify({ username: email, password: request.password, imap: request.imap, smtp: request.smtp }),
        attach: async ({ userId }) => {
          const asUser: RequestContext = { ...ctx, actor: { kind: 'user', userId } };
          const existing = (await accounts.listByUser(userId)).find((a) => a.email.trim().toLowerCase() === email.toLowerCase());
          if (existing) {
            // Same address on the same server: the provider just accepted this password, so adopt it (and the endpoints).
            await credentials.update(grantAccountAccess({ id: existing.id, userId, email: existing.email }), {
              username: email,
              password: request.password,
              imap: request.imap,
              smtp: request.smtp,
            });
            return;
          }
          await provisionAccount(asUser, { email, displayName: '', username: email, password: request.password, imap: request.imap, smtp: request.smtp }, { validate: false });
          accountCreated = true;
        },
      });

      events.publish(issued.userId, { type: 'accounts.changed' }); // after the commit
      if (accountCreated) {
        try {
          const asUser: RequestContext = { ...ctx, actor: { kind: 'user', userId: issued.userId } };
          const account = (await accounts.listByUser(issued.userId)).find((a) => a.email.trim().toLowerCase() === email.toLowerCase());
          if (account) {
            void mailbox.requestSync(await access.authorize(asUser, account.id)).catch(() => {
              // A background sync failure does not fail the sign-in
            });
          }
        } catch {
          // Ignored
        }
      }
      return {
        session: { authenticated: true, user: { id: issued.userId }, expiresAt: issued.expiresAt.toISOString() },
        token: issued.token,
        expiresAt: issued.expiresAt,
        csrfToken: issued.csrfToken,
        accountCreated,
      };
    }),

    /** Server-side revocation; the caller then clears the cookie. */
    deleteSession: defineUseCase('session.delete', async (ctx: RequestContext): Promise<void> => {
      access.requireUserId(ctx);
      if (ctx.session.status === 'active') await auth.logout(ctx.session.id);
    }),

    /** CSRF check for a cookie-authenticated mutation. */
    verifyCsrf: (ctx: RequestContext, presented: string | null): boolean =>
      ctx.session.status === 'active' && auth.verifyCsrf(ctx.session, presented),
  };
}

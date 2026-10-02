import type { UseCases } from '../../application/index.ts';
import type { RouteRegistrar } from '../route-registry.ts';

/**
 * Kaydet sign-in/out. The session secret only ever travels in the HttpOnly cookie; the JSON body is the contract
 * `Session` DTO and nothing else. The CSRF token (a different value) is returned in the `X-CSRF-Token` header.
 */
export function registerSessionRoutes(r: RouteRegistrar, u: UseCases): void {
  r.bind('getSession', async ({ ctx, session }) => {
    const view = await u.getSession(ctx);
    session.exposeCsrf(view.csrfToken);
    return view.session;
  });

  r.bind('createSession', async ({ ctx, body, session, log }) => {
    const signedIn = await u.createSession(ctx, body);
    session.start(signedIn.token, signedIn.expiresAt, signedIn.csrfToken);
    log.info({ userId: signedIn.session.user?.id }, 'sign-in succeeded'); // no identifier, no secret
    return signedIn.session;
  });

  r.bind('createMailboxSession', async ({ ctx, body, session, log }) => {
    const signedIn = await u.createMailboxSession(ctx, body);
    session.start(signedIn.token, signedIn.expiresAt, signedIn.csrfToken);
    log.info({ userId: signedIn.session.user?.id }, 'mailbox sign-in succeeded'); // no address, no secret
    return signedIn.session;
  });

  r.bind('deleteSession', async ({ ctx, session, log }) => {
    await u.deleteSession(ctx);
    session.end();
    log.info({}, 'sign-out');
  });
}

/**
 * The explicit context every use case receives. There is no ambient "current user": identity, session and
 * request metadata travel as a value, so a use case can be exercised in a test with any actor.
 */

export type Actor =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'user'; readonly userId: string };

export type SessionState =
  /** No session credential was presented. */
  | { readonly status: 'none' }
  /** A credential was presented but is no longer valid (`session_expired`, not `not_authenticated`). */
  | { readonly status: 'expired' }
  | {
      readonly status: 'active';
      readonly id: string;
      readonly expiresAt: Date;
      /** CSRF token derived from this session's secret. Sensitive-ish: never log a context. */
      readonly csrfToken: string;
    };

export interface RequestMetadata {
  readonly method: string;
  /** Route pattern (`/accounts/:accountId/folders`), never the raw URL: no ids or query strings in logs. */
  readonly route: string;
  /** Network address of the client; used ONLY for login throttling. Never logged. */
  readonly clientAddress: string;
}

export interface RequestContext {
  readonly requestId: string;
  readonly actor: Actor;
  readonly session: SessionState;
  readonly metadata: RequestMetadata;
}

export const ANONYMOUS_ACTOR: Actor = { kind: 'anonymous' };
export const NO_SESSION: SessionState = { status: 'none' };

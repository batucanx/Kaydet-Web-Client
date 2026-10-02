/**
 * Proof that an account was resolved THROUGH the caller's session/user.
 *
 * Every account-scoped port method takes an `AuthorizedAccount`, not a raw `accountId` string. The only way to
 * obtain one is `AccountAccess.authorize` (which checks ownership), because the brand symbol below is not
 * exported: a route or use case cannot pass an id it merely read from the URL straight to a repository, so the
 * "request → accountId → repository" IDOR shape does not type-check.
 */
declare const authorizedBrand: unique symbol;

export interface AuthorizedAccount {
  readonly [authorizedBrand]: true;
  readonly id: string;
  /** The owner — always the acting user. */
  readonly userId: string;
  readonly email: string;
}

/** Internal to `AccountAccess`; not re-exported from the application barrel. */
export function grantAccountAccess(input: { id: string; userId: string; email: string }): AuthorizedAccount {
  return { id: input.id, userId: input.userId, email: input.email } as AuthorizedAccount;
}

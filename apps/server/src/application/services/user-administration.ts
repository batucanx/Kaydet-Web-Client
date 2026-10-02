/**
 * Creating Kaydet users. There is no self-registration in the API contract, so this is NOT an HTTP use case: it is
 * the internal capability that tests use today and that the Phase-5 command-line tool (`user:create`) will call.
 */
import { AppError } from '../errors.ts';
import type { Clock } from '../ports/clock/clock.ts';
import type { IdGenerator } from '../ports/ids/id-generator.ts';
import type { UserRepository } from '../ports/repositories/user-repository.ts';
import type { PasswordHasher } from '../ports/security/password-hasher.ts';
import { normaliseIdentifier } from './identifier.ts';
import { checkPasswordPolicy } from './password-policy.ts';
import type { PasswordLimits } from './password-policy.ts';

export interface UserAdministration {
  /** Validates, hashes and stores. Errors carry field reasons only — never the password. */
  createUser(input: { readonly identifier: string; readonly password: string }): Promise<{ readonly userId: string }>;
}

export function createUserAdministration(deps: {
  users: UserRepository;
  hasher: PasswordHasher;
  clock: Clock;
  ids: IdGenerator;
  password: PasswordLimits;
}): UserAdministration {
  return {
    async createUser({ identifier, password }) {
      const normalised = normaliseIdentifier(identifier);
      if (normalised === null) throw new AppError('invalid_request', { fields: [{ field: 'identifier', reason: 'invalid' }] });
      const violation = checkPasswordPolicy(password, deps.password);
      if (violation !== null) throw new AppError('invalid_request', { fields: [{ field: 'password', reason: violation }] });

      const now = deps.clock.now();
      const user = { id: deps.ids.next(), identifier: normalised, passwordHash: await deps.hasher.hash(password), createdAt: now, updatedAt: now };
      if (!(await deps.users.create(user))) throw new AppError('invalid_request', { fields: [{ field: 'identifier', reason: 'taken' }] });
      return { userId: user.id };
    },
  };
}

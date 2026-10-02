/**
 * The credential vault: the only code that turns a mail credential into ciphertext and back.
 *
 *   use case ──▶ MailCredentialWriter.save/update/remove ──▶ [serialise ─ encrypt] ──▶ CredentialRepository (ciphertext)
 *   mail adapter ──▶ MailCredentialResolver.withCredentialForMailAdapter ──▶ [decrypt] ──▶ callback(plaintext) ──▶ dropped
 *
 * Properties: ciphertext is bound to (user, account) through the authenticated context, so a record copied to another
 * account fails to decrypt; a credential is replaced in ONE repository call; plaintext is only ever a local variable of
 * a callback — no cache, no return value, no log, no event, and errors carry no detail. (JavaScript cannot zero a
 * string: "smallest possible lifetime" means not retaining references, which is what this does.)
 */
import { MailEndpointSchema } from '@kaydet/domain';
import { z } from 'zod';
import { AppError } from '../errors.ts';
import type { AuthorizedAccount } from '../context/authorized-account.ts';
import type { Clock } from '../ports/clock/clock.ts';
import type { UnitOfWork } from '../ports/transaction/unit-of-work.ts';
import type { CryptoPort } from '../ports/crypto/crypto.ts';
import type { CredentialRepository } from '../ports/repositories/credential-repository.ts';
import type { MailCredential, MailCredentialPatch, MailCredentialResolver, MailCredentialWriter } from '../ports/security/mail-credential.ts';

const StoredCredentialSchema = z.strictObject({
  username: z.string().min(1),
  password: z.string().min(1),
  imap: MailEndpointSchema,
  smtp: MailEndpointSchema,
});

/** Authenticated context of a credential's ciphertext. */
const contextOf = (account: AuthorizedAccount): string => `mail-credential:v1:${account.userId}:${account.id}`;

export interface CredentialVault extends MailCredentialWriter, MailCredentialResolver {
  /** Which key encrypted the account's credential (rotation planning). `null` when none is stored. Non-secret. */
  keyIdOf(account: AuthorizedAccount): Promise<string | null>;
  /**
   * Re-encrypts the credential with the ACTIVE key (key rotation for one account). Returns whether it changed.
   * Rotating every account is a loop over accounts by a future maintenance command — not run automatically.
   */
  reencrypt(account: AuthorizedAccount): Promise<boolean>;
}

export function createCredentialVault(deps: { records: CredentialRepository; crypto: CryptoPort; clock: Clock; transactions: UnitOfWork }): CredentialVault {
  const { records, crypto, clock, transactions } = deps;

  const seal = async (account: AuthorizedAccount, credential: MailCredential): Promise<void> => {
    const sealed = await crypto.encrypt(JSON.stringify(credential), contextOf(account)).catch((error: unknown) => {
      throw new AppError('internal_error', { operation: 'credentials.encrypt', cause: error });
    });
    await records.replace(account.id, { ciphertext: sealed.ciphertext, keyId: crypto.inspect(sealed)?.keyId ?? null, updatedAt: clock.now() });
  };

  const open = async (account: AuthorizedAccount): Promise<MailCredential> => {
    const record = await records.find(account.id);
    if (record === null) throw new AppError('operation_failed', { operation: 'credentials.missing' });
    try {
      const plaintext = await crypto.decrypt({ ciphertext: record.ciphertext }, contextOf(account));
      return StoredCredentialSchema.parse(JSON.parse(plaintext));
    } catch (error) {
      // Tampering, wrong key, corrupt record: one generic failure. Nothing derived from the plaintext is kept
      // as the cause (a schema error could quote a value).
      const cause = error instanceof z.ZodError || error instanceof SyntaxError ? new Error('stored credential has an unexpected shape') : error;
      throw new AppError('internal_error', { operation: 'credentials.decrypt', cause });
    }
  };

  return {
    save: (account, credential) => seal(account, credential),

    // ATOMIC read-merge-replace: two concurrent updates cannot overwrite each other's fields.
    update: (account, patch: MailCredentialPatch) =>
      transactions.run(async () => {
        const current = await open(account);
        await seal(account, {
          username: patch.username ?? current.username,
          password: patch.password ?? current.password,
          imap: patch.imap ?? current.imap,
          smtp: patch.smtp ?? current.smtp,
        });
      }),

    remove: (account) => records.remove(account.id),

    async withCredentialForMailAdapter(account, use) {
      return use(await open(account));
    },

    async keyIdOf(account) {
      const record = await records.find(account.id);
      return record === null ? null : (crypto.inspect({ ciphertext: record.ciphertext })?.keyId ?? null);
    },

    reencrypt: (account) =>
      transactions.run(async () => {
        const record = await records.find(account.id);
        if (record === null || crypto.inspect({ ciphertext: record.ciphertext })?.keyId === crypto.activeKeyId) return false;
        await seal(account, await open(account));
        return true;
      }),
  };
}

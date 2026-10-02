/** An encrypted mail credential, exactly as stored: an opaque envelope. Plaintext never reaches a repository. */
export interface EncryptedCredentialRecord {
  readonly ciphertext: string;
  /** Id of the encryption key that produced the envelope (non-secret; lets rotation find records by key). */
  readonly keyId: string | null;
  readonly updatedAt: Date;
}

/**
 * Storage of encrypted credentials, one per mail account. `replace` swaps the whole record in ONE step (a single
 * row update in a database), so a credential update never leaves a half-written state.
 */
export interface CredentialRepository {
  find(accountId: string): Promise<EncryptedCredentialRecord | null>;
  replace(accountId: string, record: EncryptedCredentialRecord): Promise<void>;
  remove(accountId: string): Promise<void>;
}

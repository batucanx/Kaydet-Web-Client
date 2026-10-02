/**
 * Authenticated encryption for data that must never be stored as plaintext — mail credentials.
 *
 * The algorithm, key handling and payload format belong to the implementation (`infrastructure/crypto`); the
 * application only sees an opaque, self-describing envelope. The envelope names the KEY that produced it (never the
 * key itself), which is what makes key rotation possible: several keys can decrypt, one encrypts.
 */
export interface EncryptedPayload {
  /** Opaque envelope: version, algorithm, key id, nonce, ciphertext and authentication tag. Never sent to a browser. */
  readonly ciphertext: string;
}

/** Non-secret facts an envelope declares about itself. */
export interface PayloadInfo {
  readonly version: number;
  readonly algorithm: string;
  readonly keyId: string;
}

export interface CryptoPort {
  /** `context` is authenticated but not encrypted (e.g. owner + account ids): it binds a ciphertext to its record. */
  encrypt(plaintext: string, context: string): Promise<EncryptedPayload>;
  /** Throws when the payload was modified, the context differs, or the key is unknown — with a generic message. */
  decrypt(payload: EncryptedPayload, context: string): Promise<string>;
  /** Which key/version/algorithm an envelope claims, without decrypting. `null` when it is not a valid envelope. */
  inspect(payload: EncryptedPayload): PayloadInfo | null;
  /** Id of the key new encryptions use (rotation: records with another key id are candidates for re-encryption). */
  readonly activeKeyId: string;
}

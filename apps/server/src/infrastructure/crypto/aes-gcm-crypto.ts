/**
 * `CryptoPort` on AES-256-GCM (an AEAD construction from the runtime — no custom cryptography).
 *
 * Envelope (one string, the value stored in the credential record):
 *
 *     kaydet.v1.aes-256-gcm.<keyId>.<iv>.<ciphertext>.<authTag>          (parts after the prefix: base64url)
 *
 *   version    format version, so the layout can evolve
 *   algorithm  named explicitly, so a future algorithm can coexist
 *   keyId      which key encrypted it — enables rotation (the key itself is never stored or exposed)
 *   iv         96-bit random nonce, fresh for every encryption (never reused with a key)
 *   authTag    128-bit GCM tag: any change to ciphertext, iv, key id or context makes decryption fail
 *
 * The caller's `context` is passed as additional authenticated data: a ciphertext only decrypts for the record it was
 * made for. Failures are deliberately uninformative ("decryption failed") — the reason (bad tag, unknown key, wrong
 * context) is not an oracle for whoever can submit ciphertexts.
 *
 * Limits: one key protects up to ~2^32 random-nonce encryptions safely; far beyond credentials-per-account, and rotation
 * (see SECURITY.md) exists before that matters.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { CryptoPort, EncryptedPayload, PayloadInfo } from '../../application/ports/security/index.ts';
import type { KeyProvider } from './key-provider.ts';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 1;
const PREFIX = 'kaydet';
const IV_BYTES = 12;
const TAG_BYTES = 16;

interface Envelope {
  version: number;
  algorithm: string;
  keyId: string;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

const fromB64Url = (text: string): Buffer | null => (/^[A-Za-z0-9_-]*$/.test(text) ? Buffer.from(text, 'base64url') : null);

function parseEnvelope(payload: EncryptedPayload): Envelope | null {
  const parts = payload.ciphertext.split('.');
  if (parts.length !== 7 || parts[0] !== PREFIX || parts[1] !== `v${VERSION}`) return null;
  const [, , algorithm, keyId, iv, ciphertext, tag] = parts as [string, string, string, string, string, string, string];
  const ivBytes = fromB64Url(iv);
  const ctBytes = fromB64Url(ciphertext);
  const tagBytes = fromB64Url(tag);
  if (ivBytes === null || ctBytes === null || tagBytes === null || keyId === '') return null;
  return { version: VERSION, algorithm, keyId, iv: ivBytes, ciphertext: ctBytes, tag: tagBytes };
}

export class AesGcmCrypto implements CryptoPort {
  constructor(private readonly keys: KeyProvider) {}

  get activeKeyId(): string {
    return this.keys.activeKey().id;
  }

  encrypt(plaintext: string, context: string): Promise<EncryptedPayload> {
    try {
      const { id, key } = this.keys.activeKey();
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const parts = [PREFIX, `v${VERSION}`, ALGORITHM, id, iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')];
      return Promise.resolve({ ciphertext: parts.join('.') });
    } catch {
      return Promise.reject(new Error('encryption failed'));
    }
  }

  decrypt(payload: EncryptedPayload, context: string): Promise<string> {
    try {
      const envelope = parseEnvelope(payload);
      if (envelope === null || envelope.algorithm !== ALGORITHM) throw new Error('unsupported envelope');
      const key = this.keys.keyById(envelope.keyId);
      if (key === null) throw new Error('unknown key');
      if (envelope.iv.length !== IV_BYTES || envelope.tag.length !== TAG_BYTES) throw new Error('bad nonce or tag');
      const decipher = createDecipheriv(ALGORITHM, key, envelope.iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(envelope.tag);
      return Promise.resolve(Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8'));
    } catch {
      return Promise.reject(new Error('decryption failed'));
    }
  }

  inspect(payload: EncryptedPayload): PayloadInfo | null {
    const envelope = parseEnvelope(payload);
    return envelope === null ? null : { version: envelope.version, algorithm: envelope.algorithm, keyId: envelope.keyId };
  }
}

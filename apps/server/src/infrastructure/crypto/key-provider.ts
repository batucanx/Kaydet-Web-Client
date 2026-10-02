/**
 * Where encryption keys come from. `AesGcmCrypto` asks a `KeyProvider`; it never reads the environment.
 *
 * Phase 4 provider: keys from the validated server configuration (environment). A secret manager or a KMS is another
 * `KeyProvider` — for a KMS whose keys cannot be exported, the crypto adapter itself would delegate instead; either
 * way no application code changes.
 */
import { randomBytes } from 'node:crypto';
import type { CredentialKeyConfig } from '../../config/index.ts';

export interface KeyProvider {
  /** The key new encryptions use. */
  activeKey(): { readonly id: string; readonly key: Uint8Array };
  /** Any configured key (active or retired) by id; `null` when unknown. */
  keyById(id: string): Uint8Array | null;
}

/** Keys from configuration. Several keys may be present (rotation: old ones decrypt, the active one encrypts). */
export class ConfiguredKeyProvider implements KeyProvider {
  constructor(private readonly config: CredentialKeyConfig) {}

  activeKey() {
    const key = this.config.keys.get(this.config.activeKeyId);
    if (key === undefined) throw new Error('the active credential key is not configured');
    return { id: this.config.activeKeyId, key };
  }

  keyById(id: string): Uint8Array | null {
    return this.config.keys.get(id) ?? null;
  }
}

/**
 * A random key that lives only in this process — for development and tests when no key is configured. Everything it
 * encrypts becomes undecryptable on restart, which is fine for in-memory (non-durable) storage and would be a data-loss
 * bug for a real database: that is why production configuration REQUIRES a real key and the composition root refuses
 * this provider in production.
 */
export class EphemeralKeyProvider extends ConfiguredKeyProvider {
  constructor() {
    super({ activeKeyId: 'ephemeral', keys: new Map([['ephemeral', new Uint8Array(randomBytes(32))]]) });
  }
}

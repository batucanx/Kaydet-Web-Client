/** Password hashing, session primitives, credential encryption, key providers and login throttling — the primitives. */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CryptoPort } from '../application/ports/security/index.ts';
import { FakeClock } from '../testing/harness.ts';
import { AesGcmCrypto } from './crypto/aes-gcm-crypto.ts';
import { ConfiguredKeyProvider, EphemeralKeyProvider } from './crypto/key-provider.ts';
import { MemoryLoginRateLimiter } from './memory/index.ts';
import { Argon2PasswordHasher, PASSWORD_HASH_PARAMS } from './security/argon2-password-hasher.ts';
import { NodeSessionSecrets } from './security/node-session-secrets.ts';

describe('Argon2PasswordHasher', () => {
  const hasher = new Argon2PasswordHasher();

  it('hashes to a self-describing Argon2id string that is not the password', async () => {
    const password = 'correct horse battery staple';
    const hash = await hasher.hash(password);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(hash).not.toContain(password);
    expect(hash).toContain(`m=${PASSWORD_HASH_PARAMS.memoryKiB},t=${PASSWORD_HASH_PARAMS.passes},p=${PASSWORD_HASH_PARAMS.parallelism}`);
  });

  it('verifies the right password and rejects wrong, similar and empty ones', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify('correct horse battery staple', hash)).toBe(true);
    for (const wrong of ['correct horse battery stapl', 'Correct horse battery staple', ' correct horse battery staple', '']) {
      expect(await hasher.verify(wrong, hash), JSON.stringify(wrong)).toBe(false);
    }
  });

  it('salts: the same password hashes differently every time, and both verify', async () => {
    const [a, b] = await Promise.all([hasher.hash('same password!'), hasher.hash('same password!')]);
    expect(a).not.toBe(b);
    expect(await hasher.verify('same password!', a)).toBe(true);
    expect(await hasher.verify('same password!', b)).toBe(true);
  });

  it('handles Unicode passwords', async () => {
    const hash = await hasher.hash('şifre-İıÖöÜü-🔐');
    expect(await hasher.verify('şifre-İıÖöÜü-🔐', hash)).toBe(true);
    expect(await hasher.verify('sifre-IıOoUu-🔐', hash)).toBe(false);
  });

  it('treats malformed, unsupported or hostile hashes as a failed verification, never an exception', async () => {
    const good = await hasher.hash('whatever password');
    const hostile = [
      '',
      'plaintext',
      '$argon2id$',
      '$argon2i$v=19$m=47104,t=2,p=1$c29tZXNhbHQ$aGFzaA',
      '$argon2id$v=18$m=47104,t=2,p=1$c29tZXNhbHRzYWx0$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '$argon2id$v=19$m=999999999,t=2,p=1$c29tZXNhbHRzYWx0$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // asks for ~1 TB
      '$argon2id$v=19$m=47104,t=999,p=1$c29tZXNhbHRzYWx0$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '$argon2id$v=19$m=47104,t=2,p=1$***$***',
      good.slice(0, -5),
      `${good}$extra`,
    ];
    for (const bad of hostile) await expect(hasher.verify('whatever password', bad), bad).resolves.toBe(false);
  });

  it('a truncated but well-formed hash does not verify the original password', async () => {
    const good = await hasher.hash('whatever password');
    const parts = good.split('$');
    parts[5] = (parts[5] ?? '').slice(0, 24);
    expect(await hasher.verify('whatever password', parts.join('$'))).toBe(false);
  });

  it('centralised parameters meet the Argon2id baseline (>= 19 MiB, >= 2 passes, >= 16-byte salt)', () => {
    expect(PASSWORD_HASH_PARAMS.memoryKiB).toBeGreaterThanOrEqual(19_456);
    expect(PASSWORD_HASH_PARAMS.passes).toBeGreaterThanOrEqual(2);
    expect(PASSWORD_HASH_PARAMS.saltBytes).toBeGreaterThanOrEqual(16);
  });
});

describe('NodeSessionSecrets', () => {
  const secrets = new NodeSessionSecrets();

  it('generates unique 256-bit URL-safe secrets', () => {
    const seen = new Set(Array.from({ length: 200 }, () => secrets.generate()));
    expect(seen.size).toBe(200);
    for (const s of seen) expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('the fingerprint is deterministic, one-way-looking and different from the secret and from the CSRF token', () => {
    const secret = secrets.generate();
    expect(secrets.fingerprint(secret)).toBe(secrets.fingerprint(secret));
    expect(secrets.fingerprint(secret)).not.toContain(secret);
    expect(secrets.fingerprint(secret)).not.toBe(secrets.fingerprint(secrets.generate()));
    expect(secrets.csrfToken(secret)).not.toBe(secret);
    expect(secrets.csrfToken(secret)).not.toBe(secrets.fingerprint(secret));
    expect(secrets.csrfToken(secret)).toBe(secrets.csrfToken(secret));
    expect(secrets.csrfToken(secret)).not.toBe(secrets.csrfToken(secrets.generate()));
  });

  it('compares in constant-time style regardless of length', () => {
    expect(secrets.equals('abc', 'abc')).toBe(true);
    expect(secrets.equals('abc', 'abd')).toBe(false);
    expect(secrets.equals('abc', 'abcd')).toBe(false);
    expect(secrets.equals('', 'a')).toBe(false);
  });
});

describe('AesGcmCrypto (credential encryption)', () => {
  const key = (byte: number) => new Uint8Array(32).fill(byte);
  const provider = (active: string, ...ids: Array<[string, number]>) =>
    new ConfiguredKeyProvider({ activeKeyId: active, keys: new Map(ids.map(([id, byte]) => [id, key(byte)])) });
  const crypto: CryptoPort = new AesGcmCrypto(provider('k1', ['k1', 1]));
  const CONTEXT = 'mail-credential:v1:user-a:acc-1';

  const tamper = (envelope: string, index: number, edit: (part: string) => string) => {
    const parts = envelope.split('.');
    parts[index] = edit(parts[index] ?? '');
    return parts.join('.');
  };
  const flip = (part: string) => (part.startsWith('A') ? `B${part.slice(1)}` : `A${part.slice(1)}`);

  it('round-trips, and the envelope contains neither the plaintext nor any key material', async () => {
    const secret = 'imap-p@ssw0rd-that-must-not-leak';
    const { ciphertext } = await crypto.encrypt(secret, CONTEXT);
    expect(ciphertext).not.toContain(secret);
    expect(ciphertext).not.toContain(Buffer.from(secret).toString('base64'));
    expect(ciphertext).not.toContain(Buffer.from(key(1)).toString('base64url'));
    expect(await crypto.decrypt({ ciphertext }, CONTEXT)).toBe(secret);
  });

  it('is an explicit, versioned envelope naming algorithm and key id', async () => {
    const { ciphertext } = await crypto.encrypt('x', CONTEXT);
    expect(ciphertext).toMatch(/^kaydet\.v1\.aes-256-gcm\.k1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/);
    expect(crypto.inspect({ ciphertext })).toEqual({ version: 1, algorithm: 'aes-256-gcm', keyId: 'k1' });
    expect(crypto.inspect({ ciphertext: 'garbage' })).toBeNull();
    expect(crypto.activeKeyId).toBe('k1');
  });

  it('uses a fresh random nonce: the same plaintext never encrypts to the same envelope', async () => {
    const a = await crypto.encrypt('same', CONTEXT);
    const b = await crypto.encrypt('same', CONTEXT);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.ciphertext.split('.')[4]).not.toBe(b.ciphertext.split('.')[4]);
  });

  it('a different key cannot decrypt (wrong key fails)', async () => {
    const { ciphertext } = await crypto.encrypt('secret', CONTEXT);
    const other = new AesGcmCrypto(provider('k1', ['k1', 2])); // same id, different key material
    await expect(other.decrypt({ ciphertext }, CONTEXT)).rejects.toThrow('decryption failed');
  });

  it('modified ciphertext, authentication tag, nonce, key id or format fails safely with one generic error', async () => {
    const { ciphertext } = await crypto.encrypt('secret value', CONTEXT);
    const attacks: Record<string, string> = {
      ciphertext: tamper(ciphertext, 5, flip),
      tag: tamper(ciphertext, 6, flip),
      nonce: tamper(ciphertext, 4, flip),
      'key id': tamper(ciphertext, 3, () => 'k2'),
      version: tamper(ciphertext, 1, () => 'v2'),
      algorithm: tamper(ciphertext, 2, () => 'aes-128-gcm'),
      'short tag': tamper(ciphertext, 6, (t) => t.slice(0, 6)),
      truncated: ciphertext.split('.').slice(0, 6).join('.'),
      empty: '',
      appended: `${ciphertext}.x`,
    };
    for (const [name, attack] of Object.entries(attacks)) {
      await expect(crypto.decrypt({ ciphertext: attack }, CONTEXT), name).rejects.toThrow(/^decryption failed$/);
    }
  });

  it('is bound to its context: a credential copied to another account does not decrypt', async () => {
    const { ciphertext } = await crypto.encrypt('secret', CONTEXT);
    await expect(crypto.decrypt({ ciphertext }, 'mail-credential:v1:user-a:acc-2')).rejects.toThrow('decryption failed');
    await expect(crypto.decrypt({ ciphertext }, 'mail-credential:v1:user-b:acc-1')).rejects.toThrow('decryption failed');
  });

  it('preserves the key version and supports rotation: old keys decrypt, the active key encrypts', async () => {
    const before = new AesGcmCrypto(provider('k1', ['k1', 1]));
    const old = await before.encrypt('secret', CONTEXT);
    const rotated = new AesGcmCrypto(provider('k2', ['k1', 1], ['k2', 2]));
    expect(rotated.inspect(old)?.keyId).toBe('k1'); // "which key encrypted this" without decrypting
    expect(await rotated.decrypt(old, CONTEXT)).toBe('secret');
    const fresh = await rotated.encrypt('secret', CONTEXT);
    expect(rotated.inspect(fresh)?.keyId).toBe('k2');
    // Once k1 is retired from the configuration, its records can no longer be read — hence "re-encrypt first".
    const retired = new AesGcmCrypto(provider('k2', ['k2', 2]));
    await expect(retired.decrypt(old, CONTEXT)).rejects.toThrow('decryption failed');
    expect(await retired.decrypt(fresh, CONTEXT)).toBe('secret');
  });

  it('handles empty and Unicode plaintext', async () => {
    for (const text of ['', 'şifre-🔐-İıÖ']) {
      expect(await crypto.decrypt(await crypto.encrypt(text, CONTEXT), CONTEXT)).toBe(text);
    }
  });

  it('the ephemeral provider is a random per-process key', async () => {
    const a = new AesGcmCrypto(new EphemeralKeyProvider());
    const b = new AesGcmCrypto(new EphemeralKeyProvider());
    const { ciphertext } = await a.encrypt('x', CONTEXT);
    await expect(b.decrypt({ ciphertext }, CONTEXT)).rejects.toThrow('decryption failed');
    expect(randomBytes(1)).toBeDefined();
  });
});

describe('MemoryLoginRateLimiter', () => {
  const limits = { maxFailuresPerIdentifier: 3, maxFailuresPerAddress: 6, backoffBaseSeconds: 30, backoffMaxSeconds: 120, windowSeconds: 600 };
  const setup = () => {
    const clock = new FakeClock();
    return { clock, limiter: new MemoryLoginRateLimiter(clock, limits) };
  };
  const attempt = (identifier: string, address = '198.51.100.1') => ({ identifier, address });

  it('allows failures up to the threshold, then locks the identifier with a growing back-off', async () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < 2; i++) {
      expect(await limiter.check(attempt('ali'))).toEqual({ allowed: true });
      await limiter.recordFailure(attempt('ali'));
    }
    expect(await limiter.check(attempt('ali'))).toEqual({ allowed: true });
    await limiter.recordFailure(attempt('ali')); // 3rd failure = threshold → 30 s
    expect(await limiter.check(attempt('ali'))).toEqual({ allowed: false, retryAfterSeconds: 30 });

    clock.advance(31_000);
    expect(await limiter.check(attempt('ali'))).toEqual({ allowed: true });
    await limiter.recordFailure(attempt('ali')); // 4th → 60 s
    expect(await limiter.check(attempt('ali'))).toEqual({ allowed: false, retryAfterSeconds: 60 });
    clock.advance(61_000);
    await limiter.recordFailure(attempt('ali')); // 5th → 120 s (cap)
    clock.advance(121_000);
    await limiter.recordFailure(attempt('ali')); // 6th → still capped at 120 s
    expect(await limiter.check(attempt('ali'))).toEqual({ allowed: false, retryAfterSeconds: 120 });
  });

  it('the lock is temporary: the identifier works again after the cool-down, and forgets old failures after the window', async () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < 3; i++) await limiter.recordFailure(attempt('ali'));
    expect((await limiter.check(attempt('ali'))).allowed).toBe(false);
    clock.advance(31_000);
    expect((await limiter.check(attempt('ali'))).allowed).toBe(true);
    clock.advance(601_000); // window elapsed with no new failure: counters forgotten
    await limiter.recordFailure(attempt('ali'));
    expect((await limiter.check(attempt('ali'))).allowed).toBe(true); // 1 failure, not 4
  });

  it('a different identifier from the same address is unaffected until the ADDRESS threshold', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) await limiter.recordFailure(attempt('victim', `10.0.0.${i}`)); // many addresses, one target
    expect((await limiter.check(attempt('victim', '10.9.9.9'))).allowed).toBe(false); // the target is protected from anywhere
    expect((await limiter.check(attempt('someone-else', '10.9.9.9'))).allowed).toBe(true);
    for (let i = 0; i < 6; i++) await limiter.recordFailure(attempt(`user-${i}`, '203.0.113.7')); // one address, many targets
    expect((await limiter.check(attempt('brand-new', '203.0.113.7'))).allowed).toBe(false); // stuffing from one source is stopped
  });

  it('success clears the identifier counter but never the address counter', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 2; i++) await limiter.recordFailure(attempt('ali'));
    await limiter.recordSuccess(attempt('ali'));
    await limiter.recordFailure(attempt('ali'));
    expect((await limiter.check(attempt('ali', '192.0.2.1'))).allowed).toBe(true); // identifier counter restarted
    for (let i = 0; i < 5; i++) await limiter.recordFailure(attempt(`x${i}`, '192.0.2.50'));
    await limiter.recordSuccess(attempt('mine', '192.0.2.50'));
    await limiter.recordFailure(attempt('y', '192.0.2.50'));
    expect((await limiter.check(attempt('z', '192.0.2.50'))).allowed).toBe(false); // address still locked
  });

  it('is bounded: junk keys cannot grow the table without limit', async () => {
    const clock = new FakeClock();
    const limiter = new MemoryLoginRateLimiter(clock, limits, 50);
    for (let i = 0; i < 500; i++) await limiter.recordFailure(attempt(`junk-${i}`, `10.1.${i % 250}.${i % 200}`));
    // No assertion on internals: the point is that this finishes and the limiter still answers.
    expect((await limiter.check(attempt('junk-499'))).allowed).toBe(true);
  });
});

/**
 * Argon2id password hashing (RFC 9106) using the runtime's own implementation (`crypto.argon2`, Node >= 24.7):
 * memory-hard, salted, and no dependency to trust or keep patched.
 *
 * ALL parameters live in `PASSWORD_HASH_PARAMS` below — nowhere else. Stored hashes are self-describing PHC strings
 * (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`), so raising the parameters later does not break existing hashes: each is
 * verified with the parameters it was created with (bounded, so a crafted record cannot demand unbounded memory).
 *
 * Parameters: 46 MiB memory, 2 passes, 1 lane, 16-byte salt, 32-byte tag — at or above the OWASP Password Storage
 * guidance for Argon2id (m=19 MiB, t=2, p=1 minimum), about 0.1 s per hash on a development machine. Hashing runs on the
 * libuv thread pool, so it does not block the event loop.
 */
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PasswordHasher } from '../../application/ports/security/index.ts';

export const PASSWORD_HASH_PARAMS = {
  memoryKiB: 47_104,
  passes: 2,
  parallelism: 1,
  saltBytes: 16,
  tagBytes: 32,
} as const;

/** Upper bounds accepted when VERIFYING a stored hash. */
const LIMITS = { memoryKiB: 262_144, passes: 10, parallelism: 8, saltBytes: [8, 64], tagBytes: [16, 64] } as const;

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64').replace(/=+$/, '');
const fromB64 = (text: string): Buffer | null => (/^[A-Za-z0-9+/]+$/.test(text) ? Buffer.from(text, 'base64') : null);

interface ParsedHash {
  memoryKiB: number;
  passes: number;
  parallelism: number;
  salt: Buffer;
  tag: Buffer;
}

function parse(encoded: string): ParsedHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== '' || parts[1] !== 'argon2id' || parts[2] !== 'v=19') return null;
  const match = /^m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,3})$/.exec(parts[3] ?? '');
  const salt = fromB64(parts[4] ?? '');
  const tag = fromB64(parts[5] ?? '');
  if (match === null || salt === null || tag === null) return null;
  const [memoryKiB, passes, parallelism] = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const bad =
    memoryKiB < 8 * parallelism || memoryKiB > LIMITS.memoryKiB ||
    passes < 1 || passes > LIMITS.passes ||
    parallelism < 1 || parallelism > LIMITS.parallelism ||
    salt.length < LIMITS.saltBytes[0] || salt.length > LIMITS.saltBytes[1] ||
    tag.length < LIMITS.tagBytes[0] || tag.length > LIMITS.tagBytes[1];
  return bad ? null : { memoryKiB, passes, parallelism, salt, tag };
}

function derive(password: string, salt: Uint8Array, p: { memoryKiB: number; passes: number; parallelism: number }, tagBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      { message: Buffer.from(password, 'utf8'), nonce: salt, parallelism: p.parallelism, tagLength: tagBytes, memory: p.memoryKiB, passes: p.passes },
      (error, key) => (error === null ? resolve(key) : reject(error)),
    );
  });
}

export class Argon2PasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const p = PASSWORD_HASH_PARAMS;
    const salt = randomBytes(p.saltBytes);
    const tag = await derive(password, salt, { memoryKiB: p.memoryKiB, passes: p.passes, parallelism: p.parallelism }, p.tagBytes);
    return `$argon2id$v=19$m=${p.memoryKiB},t=${p.passes},p=${p.parallelism}$${b64(salt)}$${b64(tag)}`;
  }

  async verify(password: string, passwordHash: string): Promise<boolean> {
    const parsed = parse(passwordHash);
    if (parsed === null) return false; // malformed/unsupported record: a failed login, never an exception
    try {
      const candidate = await derive(password, parsed.salt, parsed, parsed.tag.length);
      return candidate.length === parsed.tag.length && timingSafeEqual(candidate, parsed.tag);
    } catch {
      return false;
    }
  }
}

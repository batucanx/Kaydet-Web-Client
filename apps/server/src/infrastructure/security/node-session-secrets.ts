import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SessionSecrets } from '../../application/ports/security/index.ts';

/**
 * Session primitives on `node:crypto`.
 *
 *  - secret:       32 random bytes, base64url (256 bits: guessing is infeasible, so a fast hash is the right tool
 *                  for the stored fingerprint — a slow password hash would only add cost per request);
 *  - fingerprint:  SHA-256 of the secret. Stored instead of the secret;
 *  - csrfToken:    HMAC-SHA-256 keyed by the secret over a fixed label. A distinct value that cannot be reversed into
 *                  the secret, needs no extra server key and dies with the session.
 */
export class NodeSessionSecrets implements SessionSecrets {
  generate(): string {
    return randomBytes(32).toString('base64url');
  }

  fingerprint(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('base64url');
  }

  csrfToken(secret: string): string {
    return createHmac('sha256', secret).update('kaydet:csrf:v1', 'utf8').digest('base64url');
  }

  equals(a: string, b: string): boolean {
    // Hash both sides to equal length first, so neither content nor length leaks through timing.
    const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest();
    return timingSafeEqual(digest(a), digest(b));
  }
}

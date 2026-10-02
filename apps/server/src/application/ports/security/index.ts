/**
 * Security-sensitive ports. NOT re-exported by `application/index.ts` (the barrel HTTP imports): only the
 * composition root, infrastructure adapters and the application's own services import this file.
 */
export type { PasswordHasher } from './password-hasher.ts';
export type { SessionSecrets } from './session-secrets.ts';
export type { LoginAttempt, LoginRateLimiter, ThrottleDecision } from './login-rate-limiter.ts';
export type { MailCredential, MailCredentialPatch, MailCredentialResolver, MailCredentialWriter } from './mail-credential.ts';
export type { CryptoPort, EncryptedPayload, PayloadInfo } from '../crypto/crypto.ts';

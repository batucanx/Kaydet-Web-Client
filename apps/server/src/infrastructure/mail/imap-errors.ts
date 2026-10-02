import { AppError, isAppError } from '../../application/errors.ts';

/**
 * Normalizes unknown IMAP errors (from imapflow, TLS, socket, DNS) into domain AppError instances.
 * Guarantees that credentials, raw passwords and internal socket traces are never leaked.
 */
export function normalizeImapError(error: unknown, operation = 'imap.operation'): AppError {
  if (isAppError(error)) {
    return error;
  }

  const err = error as Record<string, unknown> | null | undefined;
  const message = typeof err?.message === 'string' ? err.message : '';
  const code = typeof err?.code === 'string' ? err.code : '';
  const responseText = typeof err?.responseText === 'string' ? err.responseText : '';
  const responseStatus = typeof err?.responseStatus === 'string' ? err.responseStatus : '';

  // 1. Authentication failure
  if (
    responseStatus === 'NO' &&
    (responseText.includes('AUTHENTICATIONFAILED') ||
      responseText.includes('Invalid credentials') ||
      responseText.includes('Authentication failed') ||
      responseText.includes('LOGIN failed')) ||
    err?.authenticationFailed === true ||
    message.toLowerCase().includes('authentication failed') ||
    message.toLowerCase().includes('invalid credentials')
  ) {
    return new AppError('mail_credentials_rejected', {
      operation,
      cause: 'Provider rejected credentials',
    });
  }

  // 2. TLS handshake / certificate validation failure
  if (
    code === 'CERT_HAS_EXPIRED' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    code === 'HOSTNAME_MISMATCH' ||
    message.includes('self signed certificate') ||
    message.includes('certificate') ||
    message.includes('SSL routines') ||
    message.includes('TLS handshake')
  ) {
    return new AppError('provider_tls_failed', {
      operation,
      cause: 'TLS verification or handshake failed',
    });
  }

  // 3. Network unreachable / DNS failure / Timeout / Connection refused
  if (
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ECONNRESET' ||
    message.toLowerCase().includes('timeout') ||
    message.toLowerCase().includes('connection closed') ||
    message.toLowerCase().includes('failed to connect')
  ) {
    return new AppError('provider_unreachable', {
      operation,
      cause: 'Provider connection unreachable or timed out',
    });
  }

  // 4. Mailbox missing / nonexistent
  if (
    (responseStatus === 'NO' && responseText.includes('NONEXISTENT')) ||
    message.toLowerCase().includes("mailbox doesn't exist") ||
    message.toLowerCase().includes('mailbox not found')
  ) {
    return new AppError('provider_mailbox_missing', {
      operation,
      cause: 'Mailbox not found on provider',
    });
  }

  // 5. Over quota
  if (responseText.includes('OVERQUOTA') || message.toLowerCase().includes('quota exceeded')) {
    return new AppError('quota_exceeded', {
      operation,
      cause: 'Provider storage quota exceeded',
    });
  }

  // 6. Generic provider rejection
  return new AppError('provider_rejected', {
    operation,
    cause: 'Provider returned an error',
  });
}

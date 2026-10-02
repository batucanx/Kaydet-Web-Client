import { AppError, isAppError } from '../../application/errors.ts';

/**
 * Normalizes SMTP failures into contract AppError instances.
 * Guarantees no credentials or internal secrets leak into errors.
 */
export function normalizeSmtpError(error: unknown, operation = 'smtp.send'): AppError {
  if (isAppError(error)) {
    return error;
  }

  const err = error as Record<string, unknown> | null | undefined;
  const message = typeof err?.message === 'string' ? err.message : '';
  const code = typeof err?.code === 'string' ? err.code : '';
  const responseCode = typeof err?.responseCode === 'number' ? err.responseCode : 0;
  const response = typeof err?.response === 'string' ? err.response : '';

  // 1. Authentication failure (535, 534)
  if (
    responseCode === 535 ||
    responseCode === 534 ||
    response.includes('535') ||
    code === 'EAUTH' ||
    message.toLowerCase().includes('authentication') ||
    message.toLowerCase().includes('invalid login') ||
    message.toLowerCase().includes('username and password not accepted')
  ) {
    return new AppError('mail_credentials_rejected', {
      operation,
      cause: 'SMTP authentication failed',
    });
  }

  // 2. Recipient rejected (550, 551, 553, 554, 501, 503)
  if (
    responseCode === 550 ||
    responseCode === 551 ||
    responseCode === 552 ||
    responseCode === 553 ||
    responseCode === 554 ||
    code === 'EENVELOPE' ||
    response.includes('550') ||
    response.includes('553') ||
    message.toLowerCase().includes('recipient rejected') ||
    message.toLowerCase().includes('user unknown') ||
    message.toLowerCase().includes('mailbox unavailable')
  ) {
    return new AppError('recipient_rejected', {
      operation,
      cause: 'Recipient address rejected by SMTP server',
    });
  }

  // 3. TLS error
  if (
    code === 'ESOCKET' ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    message.includes('certificate') ||
    message.includes('SSL routines') ||
    message.includes('TLS')
  ) {
    return new AppError('provider_tls_failed', {
      operation,
      cause: 'SMTP TLS handshake failed',
    });
  }

  // 3.5 Ambiguous delivery outcome: connection dropped/timed out during or after DATA command
  const command = typeof err?.command === 'string' ? err.command : '';
  const isDataStage =
    command.toUpperCase() === 'DATA' ||
    command.toUpperCase() === 'END DATA' ||
    message.toUpperCase().includes('DATA') ||
    response.toUpperCase().includes('DATA');

  if (
    isDataStage &&
    (code === 'ETIMEDOUT' ||
      code === 'ECONNRESET' ||
      code === 'EPIPE' ||
      code === 'ESOCKET' ||
      message.toLowerCase().includes('timeout') ||
      message.toLowerCase().includes('connection closed') ||
      message.toLowerCase().includes('socket closed') ||
      message.toLowerCase().includes('unexpected close'))
  ) {
    return new AppError('send_failed', {
      operation,
      cause: {
        isAmbiguous: true,
        originalError: error,
        message: 'SMTP connection closed or timed out after DATA command; delivery outcome unknown',
      },
    });
  }

  // 4. Connection unreachable / DNS failure / Timeout
  if (
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    code === 'ECONNRESET' ||
    message.toLowerCase().includes('timeout') ||
    message.toLowerCase().includes('greeting never received')
  ) {
    return new AppError('provider_unreachable', {
      operation,
      cause: 'SMTP server unreachable or timed out',
    });
  }

  // 5. Generic send failure
  return new AppError('send_failed', {
    operation,
    cause: 'SMTP sending failed',
  });
}

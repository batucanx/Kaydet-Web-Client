import type { ApiError, ApiErrorCode, ApiErrorKind } from '@kaydet/domain';
import { ERROR_DEFINITIONS } from '@kaydet/domain';

export class ApiClientError extends Error {
  readonly code: ApiErrorCode | 'network_error' | 'unknown_error';
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly requestId?: string;
  readonly fields?: ApiError['fields'];
  readonly recipients?: string[];
  readonly fileNames?: string[];
  readonly retryAfterSeconds?: number;

  constructor(apiError: ApiError, status: number = ERROR_DEFINITIONS[apiError.code]?.status ?? 0) {
    super(apiError.message);
    this.name = 'ApiClientError';
    this.code = apiError.code;
    this.kind = apiError.kind;
    this.status = status;
    this.retryable = apiError.retryable;
    this.userMessage = apiError.message;
    this.requestId = apiError.requestId;
    this.fields = apiError.fields;
    this.recipients = apiError.recipients;
    this.fileNames = apiError.fileNames;
    this.retryAfterSeconds = apiError.retryAfterSeconds;
  }

  static fromNetworkError(error: unknown): ApiClientError {
    const isAbort = error instanceof DOMException && error.name === 'AbortError';
    const message = isAbort ? 'İstek iptal edildi.' : 'Ağ bağlantısı kurulamadı. Lütfen bağlantınızı kontrol edin.';
    const pseudoError: ApiError = {
      code: 'internal_error',
      kind: 'network',
      message,
      retryable: !isAbort,
    };
    return new ApiClientError(pseudoError, 0);
  }

  static fromUnknown(status: number, message = 'Beklenmeyen bir hata oluştu.'): ApiClientError {
    const pseudoError: ApiError = {
      code: 'internal_error',
      kind: 'operation_permanent',
      message,
      retryable: false,
    };
    return new ApiClientError(pseudoError, status);
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof ApiClientError && (error.userMessage === 'İstek iptal edildi.' || error.message === 'İstek iptal edildi.')) {
    return true;
  }
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted') || error.message.includes('İstek iptal edildi')))
  );
}

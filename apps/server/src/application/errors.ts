/**
 * The one error type of the application layer.
 *
 * Use cases and port adapters signal every EXPECTED failure by throwing an `AppError` that carries a contract
 * `ApiErrorCode` (`packages/domain/src/api/errors.ts`): the code decides kind, HTTP status, retry policy and the
 * user-safe message. Anything else that is thrown (a bug, a driver failure) is unexpected and is mapped to
 * `internal_error` by the HTTP error handler — its message never leaves the server.
 *
 * `cause` and `operation` are for server-side logs only; they are never serialised into a response.
 */
import { ERROR_DEFINITIONS } from '@kaydet/domain';
import type { ApiErrorCode, ApiErrorExtras } from '@kaydet/domain';

export interface AppErrorOptions extends Omit<ApiErrorExtras, 'requestId'> {
  /** Use case / operation name for logs (`accounts.delete`). Filled in by `defineUseCase` when absent. */
  operation?: string;
  /** Underlying error (driver, provider…). Logged, never exposed. */
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly options: AppErrorOptions;

  constructor(code: ApiErrorCode, options: AppErrorOptions = {}) {
    super(`${code}${options.operation !== undefined ? ` (${options.operation})` : ''}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.options = options;
  }

  get kind() {
    return ERROR_DEFINITIONS[this.code].kind;
  }

  get operation(): string | undefined {
    return this.options.operation;
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;

/**
 * Wraps a use case so every failure carries its operation name and unexpected errors become an `AppError`
 * (`internal_error`) with the original as `cause`. This is where "application errors are logged with the
 * use-case name" comes from; routes contain no try/catch.
 */
export function defineUseCase<Args extends unknown[], Result>(
  operation: string,
  fn: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (isAppError(error)) {
        if (error.operation === undefined) throw new AppError(error.code, { ...error.options, operation, cause: error.options.cause ?? error });
        throw error;
      }
      throw new AppError('internal_error', { operation, cause: error });
    }
  };
}

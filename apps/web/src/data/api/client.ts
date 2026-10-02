import { ApiErrorResponseSchema } from '@kaydet/domain';
import { ApiClientError } from './errors';

export interface ApiClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

const DEFAULT_BASE_URL =
  typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL
    ? import.meta.env.VITE_API_URL
    : 'http://localhost:3001/api';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private csrfToken: string | null = null;
  private readonly unauthorizedListeners = new Set<() => void>();

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  getCsrfToken(): string | null {
    return this.csrfToken;
  }

  setCsrfToken(token: string | null): void {
    this.csrfToken = token;
  }

  onUnauthorized(listener: () => void): () => void {
    this.unauthorizedListeners.add(listener);
    return () => {
      this.unauthorizedListeners.delete(listener);
    };
  }

  private notifyUnauthorized(): void {
    for (const listener of this.unauthorizedListeners) {
      try {
        listener();
      } catch {
        // Suppress listener errors
      }
    }
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const method = options.method ?? 'GET';
    const url = new URL(`${this.baseUrl}${options.path.startsWith('/') ? '' : '/'}${options.path}`);

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
    };

    if (options.body !== undefined && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    if (STATE_CHANGING_METHODS.has(method) && this.csrfToken) {
      headers['x-csrf-token'] = this.csrfToken;
    }

    if (options.signal?.aborted) {
      throw ApiClientError.fromNetworkError(new DOMException('The user aborted a request.', 'AbortError'));
    }

    let response: Response;
    try {
      response = await this.fetchFn(url.toString(), {
        method,
        headers,
        body: options.body !== undefined ? (options.body instanceof FormData ? options.body : JSON.stringify(options.body)) : undefined,
        credentials: 'include',
        signal: options.signal,
      });
    } catch (error) {
      throw ApiClientError.fromNetworkError(error);
    }

    // Capture CSRF token from response headers if provided
    const newCsrf = response.headers.get('x-csrf-token');
    if (newCsrf) {
      this.csrfToken = newCsrf;
    }

    if (!response.ok) {
      let clientError: ApiClientError;
      try {
        const body: unknown = await response.json();
        const parsed = ApiErrorResponseSchema.safeParse(body);
        if (parsed.success) {
          clientError = new ApiClientError(parsed.data.error, response.status);
        } else {
          clientError = ApiClientError.fromUnknown(response.status);
        }
      } catch {
        clientError = ApiClientError.fromUnknown(response.status);
      }

      if (response.status === 401) {
        this.notifyUnauthorized();
      }

      throw clientError;
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  get<T>(path: string, options?: Omit<RequestOptions, 'method' | 'path'>): Promise<T> {
    return this.request<T>({ ...options, method: 'GET', path });
  }

  post<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'path' | 'body'>): Promise<T> {
    return this.request<T>({ ...options, method: 'POST', path, body });
  }

  put<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'path' | 'body'>): Promise<T> {
    return this.request<T>({ ...options, method: 'PUT', path, body });
  }

  patch<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'path' | 'body'>): Promise<T> {
    return this.request<T>({ ...options, method: 'PATCH', path, body });
  }

  delete<T>(path: string, options?: Omit<RequestOptions, 'method' | 'path'>): Promise<T> {
    return this.request<T>({ ...options, method: 'DELETE', path });
  }
}

export const defaultApiClient = new ApiClient();

import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client';
import { ApiClientError } from './errors';

describe('ApiClient', () => {
  it('makes successful GET requests and parses JSON', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ hello: 'world' }),
    });

    const client = new ApiClient({ baseUrl: 'http://api.test/api', fetchFn: mockFetch });
    const result = await client.get<{ hello: string }>('/test');

    expect(result).toEqual({ hello: 'world' });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://api.test/api/test',
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        headers: expect.objectContaining({ Accept: 'application/json' }),
      }),
    );
  });

  it('captures x-csrf-token from response headers and sends on state-changing requests', async () => {
    const mockFetch = vi
      .fn()
      // First request: GET /session returns x-csrf-token header
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'x-csrf-token': 'csrf-secret-123' }),
        json: async () => ({ authenticated: true }),
      })
      // Second request: POST /accounts
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers(),
        json: async () => ({ id: 'acc-1' }),
      });

    const client = new ApiClient({ baseUrl: 'http://api.test/api', fetchFn: mockFetch });

    await client.get('/session');
    expect(client.getCsrfToken()).toBe('csrf-secret-123');

    await client.post('/accounts', { name: 'Work' });
    expect(mockFetch).toHaveBeenLastCalledWith(
      'http://api.test/api/accounts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-csrf-token': 'csrf-secret-123',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ name: 'Work' }),
      }),
    );
  });

  it('does not send x-csrf-token on GET requests', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ items: [] }),
    });

    const client = new ApiClient({ baseUrl: 'http://api.test/api', fetchFn: mockFetch });
    client.setCsrfToken('csrf-token-abc');

    await client.get('/accounts');
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['x-csrf-token']).toBeUndefined();
  });

  it('parses structured ApiError on non-2xx responses and sets correct fields', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      json: async () => ({
        error: {
          code: 'folder_not_found',
          kind: 'not_found',
          message: 'Klasör bulunamadı.',
          retryable: false,
          requestId: 'req-404',
        },
      }),
    });

    const client = new ApiClient({ baseUrl: 'http://api.test/api', fetchFn: mockFetch });

    try {
      await client.get('/accounts/a1/folders/f99');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiClientError);
      const apiErr = err as ApiClientError;
      expect(apiErr.code).toBe('folder_not_found');
      expect(apiErr.kind).toBe('not_found');
      expect(apiErr.status).toBe(404);
      expect(apiErr.userMessage).toBe('Klasör bulunamadı.');
      expect(apiErr.requestId).toBe('req-404');
      expect(apiErr.retryable).toBe(false);
    }
  });

  it('notifies unauthorized listeners on 401 response', async () => {
    const onUnauthorized = vi.fn();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: async () => ({
        error: {
          code: 'session_expired',
          kind: 'authentication',
          message: 'Oturumunuzun süresi doldu. Yeniden giriş yapın.',
          retryable: false,
        },
      }),
    });

    const client = new ApiClient({ baseUrl: 'http://api.test/api', fetchFn: mockFetch });
    const unsubscribe = client.onUnauthorized(onUnauthorized);

    await expect(client.get('/accounts')).rejects.toThrow();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    unsubscribe();
    await expect(client.get('/accounts')).rejects.toThrow();
    expect(onUnauthorized).toHaveBeenCalledTimes(1); // not called again after unsubscribe
  });

  it('handles network failures gracefully with Turkish userMessage', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const client = new ApiClient({ baseUrl: 'http://api.test/api', fetchFn: mockFetch });

    try {
      await client.get('/accounts');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiClientError);
      const apiErr = err as ApiClientError;
      expect(apiErr.kind).toBe('network');
      expect(apiErr.userMessage).toContain('Ağ bağlantısı');
      expect(apiErr.retryable).toBe(true);
    }
  });

  it('handles 204 No Content response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: new Headers(),
    });

    const client = new ApiClient({ baseUrl: 'http://api.test/api', fetchFn: mockFetch });
    const res = await client.delete('/accounts/a1');
    expect(res).toBeUndefined();
  });

  it('supports request cancellation via AbortSignal', async () => {
    const controller = new AbortController();
    const mockFetch = vi.fn().mockImplementation((_url, opts) => {
      if (opts.signal?.aborted) {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => ({}) });
    });

    const client = new ApiClient({ baseUrl: 'http://api.test/api', fetchFn: mockFetch });
    controller.abort();

    await expect(client.get('/messages', { signal: controller.signal })).rejects.toThrow();
  });
});

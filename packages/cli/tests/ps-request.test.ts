/**
 * Tests for R-025: psRequest must respect HTTP status codes.
 *
 * Before R-025 the helper called JSON.parse on the body for any response,
 * so 401 / 403 / 5xx replies silently became "no data". The tests below
 * exercise the status-aware behaviour by feeding fake responses into
 * `performRequest` (the same helper that backs `psRequest` in production).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  performRequest,
  AuthError,
  ServerError,
  RequestError,
  apiEvents,
  type RawRequester,
  type AuthFailurePayload,
} from '../src/api-errors.js';

const fakeFetcher = (
  responses: Array<
    | { statusCode: number; body: string }
    | { throw: Error }
  >,
): RawRequester => {
  const queue = [...responses];
  return vi.fn(async (_method: string, _path: string, _body?: unknown) => {
    const next = queue.shift();
    if (!next) throw new Error('fakeFetcher: ran out of responses');
    if ('throw' in next) throw next.throw;
    return { statusCode: next.statusCode, body: next.body };
  });
};

describe('performRequest (R-025)', () => {
  beforeEach(() => {
    apiEvents.removeAllListeners('authFailure');
  });

  it('parses JSON on 2xx', async () => {
    const fetcher = fakeFetcher([
      { statusCode: 200, body: JSON.stringify({ data: { id: 'p1' } }) },
    ]);
    const out = await performRequest<{ data: { id: string } }>(
      'GET',
      '/api/projects/p1',
      undefined,
      fetcher,
    );
    expect(out).toEqual({ data: { id: 'p1' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('throws AuthError and emits authFailure on 401', async () => {
    const fetcher = fakeFetcher([
      { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) },
    ]);
    const captured: AuthFailurePayload[] = [];
    apiEvents.on('authFailure', (p: AuthFailurePayload) => captured.push(p));

    await expect(
      performRequest('GET', '/api/projects', undefined, fetcher),
    ).rejects.toBeInstanceOf(AuthError);

    expect(captured).toHaveLength(1);
    expect(captured[0].statusCode).toBe(401);
    expect(captured[0].path).toBe('/api/projects');
    expect(captured[0].message).toMatch(/re-login/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('throws AuthError and emits authFailure on 403', async () => {
    const fetcher = fakeFetcher([{ statusCode: 403, body: '' }]);
    const captured: AuthFailurePayload[] = [];
    apiEvents.on('authFailure', (p: AuthFailurePayload) => captured.push(p));

    await expect(
      performRequest('PATCH', '/api/projects/p1', { name: 'x' }, fetcher),
    ).rejects.toMatchObject({
      name: 'AuthError',
      statusCode: 403,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].statusCode).toBe(403);
  });

  it('retries once on 5xx and succeeds on second try', async () => {
    const fetcher = fakeFetcher([
      { statusCode: 503, body: 'service unavailable' },
      { statusCode: 200, body: JSON.stringify({ ok: true }) },
    ]);
    const result = await performRequest<{ ok: boolean }>(
      'GET',
      '/api/health',
      undefined,
      fetcher,
    );
    expect(result).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('throws ServerError after retry still fails on 5xx', async () => {
    const fetcher = fakeFetcher([
      { statusCode: 500, body: 'boom' },
      { statusCode: 502, body: 'still down' },
    ]);
    const err = await performRequest('GET', '/api/health', undefined, fetcher).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ServerError);
    expect((err as ServerError).statusCode).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries once on network errors then succeeds', async () => {
    const fetcher = fakeFetcher([
      { throw: new Error('ECONNRESET') },
      { statusCode: 200, body: JSON.stringify({ data: [] }) },
    ]);
    const out = await performRequest<{ data: unknown[] }>(
      'GET',
      '/api/projects',
      undefined,
      fetcher,
    );
    expect(out).toEqual({ data: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 4xx non-auth (e.g. 400 bad request)', async () => {
    const fetcher = fakeFetcher([
      { statusCode: 400, body: JSON.stringify({ error: 'bad input' }) },
    ]);
    const err = await performRequest('POST', '/api/plans', { foo: 1 }, fetcher).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).statusCode).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 401 (no point retrying with the same bad key)', async () => {
    const fetcher = fakeFetcher([{ statusCode: 401, body: '' }]);
    await expect(
      performRequest('GET', '/api/projects', undefined, fetcher),
    ).rejects.toBeInstanceOf(AuthError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for 204-style empty 2xx body', async () => {
    const fetcher = fakeFetcher([{ statusCode: 204, body: '' }]);
    const out = await performRequest('DELETE', '/api/projects/p1', undefined, fetcher);
    expect(out).toBeUndefined();
  });

  it('does not silently swallow malformed 2xx JSON', async () => {
    const fetcher = fakeFetcher([
      { statusCode: 200, body: 'not-json{{{' },
    ]);
    await expect(
      performRequest('GET', '/api/projects', undefined, fetcher),
    ).rejects.toThrow(/parse/i);
  });
});

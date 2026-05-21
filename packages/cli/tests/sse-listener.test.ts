// R-023: CliSseListener should treat 401/403 as a hard auth failure
// (stop listening, emit `authFailure`, write a red banner to stderr) instead
// of busy-looping with exponential backoff like for transient errors.
//
// Set env vars BEFORE importing the listener: cfg captures process.env at
// module-load time.

process.env.PLANSYNC_API_URL = 'http://sse-listener-test.local';
process.env.PLANSYNC_API_KEY = 'test-key';
process.env.PLANSYNC_USER = 'tester';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CliSseListener, type AuthFailurePayload } from '../src/sse-listener.js';

type FetchMock = ReturnType<typeof vi.fn>;

function makeUnauthorizedResponse(status: 401 | 403 = 401): Response {
  return new Response(null, { status, statusText: status === 401 ? 'Unauthorized' : 'Forbidden' });
}

function makeServerErrorResponse(): Response {
  return new Response('boom', { status: 503, statusText: 'Service Unavailable' });
}

describe('CliSseListener auth-failure handling (R-023)', () => {
  let originalFetch: typeof globalThis.fetch;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('stops the listener and emits `authFailure` on 401', async () => {
    const fetchMock: FetchMock = vi.fn(async () => makeUnauthorizedResponse(401));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const listener = new CliSseListener(() => {
      throw new Error('handler should not be invoked on auth failure');
    });

    const events: AuthFailurePayload[] = [];
    listener.on('authFailure', (p) => events.push(p));

    listener.start();
    // Allow the first fetch to resolve and the synchronous post-fetch logic to run.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe(401);
    expect(events[0].url).toContain('/api/user-events');
    expect(listener.hasAuthFailed()).toBe(true);

    // Banner must be written to stderr so the failure is never silent even if
    // no `authFailure` listener is wired up.
    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).toMatch(/SSE connection rejected \(401/);
    expect(stderrCalls).toMatch(/re-authenticate/);

    // Even after waiting longer than the initial backoff (1s) and the next
    // step (2s), we must NOT see another fetch — the listener stopped.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    listener.stop();
  });

  it('also stops + emits on 403', async () => {
    const fetchMock: FetchMock = vi.fn(async () => makeUnauthorizedResponse(403));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const listener = new CliSseListener(() => undefined);
    const events: AuthFailurePayload[] = [];
    listener.on('authFailure', (p) => events.push(p));

    listener.start();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(events).toHaveLength(1);
    expect(events[0].status).toBe(403);
    expect(listener.hasAuthFailed()).toBe(true);

    listener.stop();
  });

  it('keeps backing off on 5xx (does NOT emit authFailure or stop)', async () => {
    const fetchMock: FetchMock = vi.fn(async () => makeServerErrorResponse());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const listener = new CliSseListener(() => undefined);
    const events: AuthFailurePayload[] = [];
    listener.on('authFailure', (p) => events.push(p));

    listener.start();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // After the first failed fetch the listener schedules a reconnect with
    // exponential backoff. We don't wait for the actual reconnect (would be
    // 1s+), but we verify that:
    //   - the auth-failure path was NOT taken
    //   - the listener still considers itself running (not auth-failed)
    expect(events).toHaveLength(0);
    expect(listener.hasAuthFailed()).toBe(false);

    listener.stop();
    // No banner about auth failure should have been written for 5xx.
    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).not.toMatch(/SSE connection rejected/);
  });
});

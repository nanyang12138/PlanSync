import { describe, expect, it, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../../src/middleware';

const ALLOWED_ORIGIN = 'http://localhost:3001';
const FOREIGN_ORIGIN = 'https://evil.example.com';

function makeRequest(opts: {
  method?: string;
  origin?: string | null;
  pathname?: string;
}): NextRequest {
  const headers = new Headers();
  if (opts.origin) headers.set('origin', opts.origin);
  // The middleware reads `origin` and the cookie store. NextRequest expects
  // a full URL.
  const url = `http://localhost${opts.pathname ?? '/api/projects/p1/events'}`;
  return new NextRequest(url, {
    method: opts.method ?? 'GET',
    headers,
  });
}

describe('middleware CORS — credentialed cross-origin requests (#134, #135)', () => {
  beforeEach(() => {
    // Allow the test "origin" to pass the allow-list. The middleware reads
    // process.env at module-load time via a top-level constant; the values
    // set in tests/setup.ts are sufficient since localhost:3001 is hard-coded
    // into ALLOWED_ORIGINS.
  });

  it('echoes Access-Control-Allow-Origin and sets Access-Control-Allow-Credentials: true for an allowed origin', () => {
    const res = middleware(makeRequest({ origin: ALLOWED_ORIGIN }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    // The browser will silently drop credentialed responses (cookie-based
    // session, EventSource withCredentials, fetch credentials:'include')
    // unless the server opts in via this header. Without it, /api/user-events
    // SSE would authenticate as anonymous on cross-origin deployments.
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('appends Vary: Origin so caches do not serve cross-origin response to a different origin', () => {
    const res = middleware(makeRequest({ origin: ALLOWED_ORIGIN }));
    // Vary may already include other tokens; we just need Origin in there.
    const vary = res.headers.get('Vary') ?? '';
    expect(vary.split(',').map((s) => s.trim())).toContain('Origin');
  });

  it('does NOT emit Access-Control-Allow-Credentials when origin is not in the allow-list', () => {
    const res = middleware(makeRequest({ origin: FOREIGN_ORIGIN }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('OPTIONS preflight from an allowed origin returns 204 with credentials header set', () => {
    const res = middleware(makeRequest({ method: 'OPTIONS', origin: ALLOWED_ORIGIN }));
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
  });
});

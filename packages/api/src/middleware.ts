import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { REQUEST_ID_HEADER, resolveRequestId } from './lib/request-context';

const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  process.env.NEXT_PUBLIC_APP_URL,
  ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : []),
]
  .filter(Boolean)
  .map((o) => o!.replace(/\/$/, ''));

export function middleware(request: NextRequest) {
  const origin = request.headers.get('origin');
  const authDisabled = process.env.AUTH_DISABLED === 'true';
  const pathname = request.nextUrl.pathname;

  const isLoginPage = pathname === '/login';
  const isLoginApi = pathname === '/api/auth/login';
  const isLogoutApi = pathname === '/api/auth/logout';
  const isPublic = isLoginPage || isLoginApi || isLogoutApi;
  const isApiRoute = pathname.startsWith('/api/');

  const requestHeaders = new Headers(request.headers);

  // R-111: ensure every request has a stable correlation id. Reuse an
  // inbound id from upstream proxies (when it matches a safe shape) so a
  // single id can be threaded end-to-end; otherwise mint a fresh uuid v4.
  const reqId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
  requestHeaders.set(REQUEST_ID_HEADER, reqId);

  const apiKey = request.cookies.get('plansync-apikey')?.value;

  if (apiKey) {
    // Forward personal API key as Authorization header — API routes verify this
    requestHeaders.set('authorization', `Bearer ${apiKey}`);
  } else {
    // Fallback: legacy username cookie (AUTH_DISABLED mode or not yet logged in)
    const existingUser = request.cookies.get('plansync-user')?.value;
    const defaultUser = process.env.PLANSYNC_USER || process.env.USER || 'anonymous';
    const userName = existingUser ?? defaultUser;
    if (userName && !requestHeaders.get('x-user-name')) {
      requestHeaders.set('x-user-name', userName);
    }
  }

  // Redirect unauthenticated web requests to /login (only when auth is enabled)
  if (!authDisabled && !apiKey && !isPublic && !isApiRoute) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  // Echo the request id back to the caller so clients (and downstream
  // observability) can correlate a single API call with its server logs.
  response.headers.set(REQUEST_ID_HEADER, reqId);

  // Auto-set legacy cookie on first visit in AUTH_DISABLED mode
  if (authDisabled && !apiKey && !request.cookies.get('plansync-user')?.value) {
    const defaultUser = process.env.PLANSYNC_USER || process.env.USER || '';
    if (defaultUser) {
      response.cookies.set('plansync-user', defaultUser, {
        path: '/',
        maxAge: 31536000,
        sameSite: 'lax',
      });
    }
  }

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    response.headers.set(
      'Access-Control-Allow-Headers',
      // Last-Event-ID: SSE clients automatically send this header when the
      // browser reconnects after a network blip; #247 — without it the
      // cross-origin reconnect preflight is rejected and the EventSource
      // gives up. Authorization / X-User-Name carry the session.
      'Content-Type, Authorization, X-User-Name, Last-Event-ID',
    );
    // ACAC must be set exactly once — see #244, #248. Browsers reject
    // credentialed requests (cookie-based session, EventSource with
    // withCredentials, fetch credentials:'include') unless the server
    // opts in via this header. Per spec, ACAO must be a specific origin
    // (not '*') when ACAC is true — we already echo the origin above.
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    // #295: x-request-id is already added by the request-context wrapper;
    // expose it so cross-origin clients can read it via fetch / EventSource
    // for log correlation.
    response.headers.set('Access-Control-Expose-Headers', 'x-request-id');
    // Vary on Origin so caches don't serve a response for one origin to
    // another origin behind the same URL.
    response.headers.append('Vary', 'Origin');
    response.headers.set('Access-Control-Max-Age', '86400');
  }

  if (request.method === 'OPTIONS') {
    const preflight = new NextResponse(null, { status: 204, headers: response.headers });
    // NextResponse(null, { headers }) does not always preserve every header
    // we set on `response` (CORS path), so reapply the request id explicitly.
    preflight.headers.set(REQUEST_ID_HEADER, reqId);
    return preflight;
  }

  return response;
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
};

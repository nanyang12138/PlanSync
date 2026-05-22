import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

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
      'Content-Type, Authorization, X-User-Name',
    );
    // Browsers reject credentialed requests (cookie-based session, EventSource
    // with withCredentials, fetch with credentials: 'include') unless the
    // server explicitly opts in. Without this header the user-events SSE
    // stream and any cross-origin fetch would silently lose the session
    // cookie set in `plansync-apikey` / `plansync-user`. Note: per spec,
    // ACAO must be a specific origin (not '*') when ACAC is true — we already
    // echo the origin above, so this combination is valid.
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    // Vary on Origin so caches don't serve a response for one origin to
    // another origin behind the same URL.
    response.headers.append('Vary', 'Origin');
    response.headers.set('Access-Control-Max-Age', '86400');
    // R-089 review #135: SSE clients call `new EventSource(url, { withCredentials: true })`
    // so the cookie-bearing cross-origin request requires this CORS response
    // header. Without it the browser drops the cookie and SSE auth silently
    // fails on cross-origin deployments.
    response.headers.set('Access-Control-Allow-Credentials', 'true');
  }

  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: response.headers });
  }

  return response;
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
};

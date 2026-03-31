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

  // Use existing cookie, or fall back to PLANSYNC_USER / system USER
  const existingUser = request.cookies.get('plansync-user')?.value;
  const defaultUser = process.env.PLANSYNC_USER || process.env.USER || 'anonymous';
  const userName = existingUser ?? defaultUser;

  const requestHeaders = new Headers(request.headers);
  if (userName && !requestHeaders.get('x-user-name')) {
    requestHeaders.set('x-user-name', userName);
  }

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  // Auto-set cookie on first visit so browser identity matches server identity
  if (!existingUser && defaultUser !== 'anonymous') {
    response.cookies.set('plansync-user', defaultUser, {
      path: '/',
      maxAge: 31536000,
      sameSite: 'lax',
    });
  }

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    response.headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-User-Name',
    );
    response.headers.set('Access-Control-Max-Age', '86400');
  }

  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: response.headers });
  }

  return response;
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
};

import { NextRequest, NextResponse } from 'next/server';
import { enterRequestContextFromHeaders } from '@/lib/request-context';

export async function POST(req: NextRequest) {
  enterRequestContextFromHeaders(req.headers);
  const response = NextResponse.json({ success: true });

  // #347: must clear the cookies with the SAME sameSite + secure attributes
  // they were issued with by /api/auth/login, otherwise the browser keeps
  // the original cookie alongside the (different-attribute) empty one and
  // the session leaks past logout. Mirror the login route's logic exactly.
  const crossSite = process.env.PLANSYNC_COOKIE_CROSS_SITE === 'true';
  const sameSite = crossSite ? ('none' as const) : ('lax' as const);
  const secure = crossSite || process.env.NODE_ENV === 'production';

  response.cookies.set('plansync-apikey', '', {
    path: '/',
    maxAge: 0,
    sameSite,
    secure,
    httpOnly: true,
  });
  response.cookies.set('plansync-user', '', {
    path: '/',
    maxAge: 0,
    sameSite,
    secure,
  });
  return response;
}

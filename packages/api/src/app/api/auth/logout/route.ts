import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest) {
  // Revoke JWT refresh token from DB if userName is known
  const userName =
    req.cookies.get('plansync-user')?.value ?? req.headers.get('x-user-name');

  if (userName) {
    await prisma.apiKey
      .deleteMany({ where: { name: 'jwt-refresh', createdBy: userName } })
      .catch(() => {}); // best-effort; never fail a logout
  }

  const response = NextResponse.json({ success: true });
  response.cookies.set('plansync-apikey', '', { path: '/', maxAge: 0 });
  response.cookies.set('plansync-user', '', { path: '/', maxAge: 0 });
  response.cookies.set('plansync-jwt', '', { path: '/', maxAge: 0 });
  response.cookies.set('plansync-jwt-refresh', '', { path: '/', maxAge: 0 });
  return response;
}

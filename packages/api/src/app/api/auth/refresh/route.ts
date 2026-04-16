import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyToken, signAccessToken, hashJti } from '@/lib/jwt';
import { handleApiError } from '@/lib/errors';

export async function POST(req: NextRequest) {
  try {
    // Accept refresh token from Authorization header or cookie
    const authHeader = req.headers.get('authorization');
    const token =
      (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null) ??
      req.cookies.get('plansync-jwt-refresh')?.value;

    if (!token) {
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Refresh token required' } },
        { status: 401 },
      );
    }

    // 1. Verify JWT signature + expiry + type
    const { userName, jti } = verifyToken(token, 'refresh');
    if (!jti) {
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid refresh token: missing jti' } },
        { status: 401 },
      );
    }

    // 2. Check JTI exists in DB (not revoked)
    const storedKey = await prisma.apiKey.findFirst({
      where: {
        name: 'jwt-refresh',
        createdBy: userName,
        keyPrefix: jti.slice(0, 8),
      },
    });
    if (!storedKey || storedKey.keyHash !== hashJti(jti)) {
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Refresh token revoked or not found' } },
        { status: 401 },
      );
    }

    // 3. Issue new access token
    const accessToken = signAccessToken(userName);
    const accessExpiry = parseInt(process.env.JWT_ACCESS_EXPIRY ?? '900', 10);

    const response = NextResponse.json({ data: { accessToken, userName } });
    response.cookies.set('plansync-jwt', accessToken, {
      path: '/',
      maxAge: accessExpiry,
      sameSite: 'lax',
      httpOnly: true,
    });
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}

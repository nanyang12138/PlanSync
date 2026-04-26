import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { signAccessToken } from '@/lib/jwt';

async function verifyTokenHash(raw: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(raw, salt, 64, (err, dk) => {
      if (err) reject(err);
      else resolve(crypto.timingSafeEqual(dk, expected));
    });
  });
}

// Refresh token format: <jti>.<random> (opaque, not a JWT)
// jti is the DB record ID; hash of the full token is stored for verification.
export async function POST(req: NextRequest) {
  try {
    let rawRefresh: string | null = null;

    const body = await req.json().catch(() => ({}));
    if (typeof body.refreshToken === 'string') {
      rawRefresh = body.refreshToken;
    }
    if (!rawRefresh) {
      rawRefresh = req.cookies.get('plansync-refresh')?.value ?? null;
    }

    if (!rawRefresh) {
      return NextResponse.json({ error: 'refreshToken required' }, { status: 400 });
    }

    const jti = rawRefresh.split('.')[0];
    if (!jti) {
      return NextResponse.json({ error: 'Invalid refresh token' }, { status: 401 });
    }

    const stored = await prisma.refreshToken.findUnique({ where: { id: jti } });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      return NextResponse.json({ error: 'Refresh token expired or revoked' }, { status: 401 });
    }

    const valid = await verifyTokenHash(rawRefresh, stored.tokenHash);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid refresh token' }, { status: 401 });
    }

    const accessToken = await signAccessToken(stored.userName);

    return NextResponse.json({ success: true, accessToken, userName: stored.userName });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Refresh error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

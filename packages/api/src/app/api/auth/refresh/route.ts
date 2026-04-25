import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { signAccessToken, generateRefreshToken } from '@/lib/jwt';

async function verifyScrypt(raw: string, stored: string): Promise<boolean> {
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

async function scryptHash(raw: string, salt: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(raw, salt, 64, (err, dk) => {
      if (err) reject(err);
      else resolve(`${salt.toString('hex')}:${dk.toString('hex')}`);
    });
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { refreshToken } = body as { refreshToken?: string };

    if (!refreshToken) {
      return NextResponse.json({ error: 'refreshToken required' }, { status: 400 });
    }

    // Find candidates by prefix (first 15 chars) — same lookup pattern as api key auth
    const prefix = refreshToken.slice(0, 15);
    const candidates = await prisma.apiKey.findMany({
      where: {
        name: 'jwt-refresh',
        keyPrefix: prefix,
        expiresAt: { gt: new Date() },
      },
    });

    let matched: (typeof candidates)[0] | null = null;
    for (const candidate of candidates) {
      if (await verifyScrypt(refreshToken, candidate.keyHash)) {
        matched = candidate;
        break;
      }
    }

    if (!matched) {
      return NextResponse.json({ error: 'Invalid or expired refresh token' }, { status: 401 });
    }

    const userName = matched.createdBy;

    // Rotate: delete old token, issue new one
    await prisma.apiKey.delete({ where: { id: matched.id } });
    const newRawRefresh = generateRefreshToken();
    const refreshSalt = crypto.randomBytes(16);
    const refreshHash = await scryptHash(newRawRefresh, refreshSalt);
    await prisma.apiKey.create({
      data: {
        name: 'jwt-refresh',
        keyHash: refreshHash,
        keyPrefix: newRawRefresh.slice(0, 15),
        permissions: ['refresh'],
        createdBy: userName,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const accessToken = signAccessToken(userName);
    return NextResponse.json({ accessToken, refreshToken: newRawRefresh, expiresIn: 900 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Refresh error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

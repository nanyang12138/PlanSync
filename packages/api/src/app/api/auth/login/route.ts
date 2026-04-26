import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { signAccessToken, signRefreshToken, REFRESH_TTL_SECONDS } from '@/lib/jwt';

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, dk) => {
      if (err) reject(err);
      else resolve(`${salt.toString('hex')}:${dk.toString('hex')}`);
    });
  });
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, dk) => {
      if (err) reject(err);
      else resolve(crypto.timingSafeEqual(dk, expected));
    });
  });
}

async function hashToken(raw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
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
    const { userName, password } = body as { userName?: string; password?: string };

    if (!userName?.trim() || !password) {
      return NextResponse.json({ error: 'userName and password required' }, { status: 400 });
    }

    const name = userName.trim();

    // Look up user account
    const account = await prisma.userAccount.findUnique({ where: { userName: name } });

    if (account) {
      // Existing account: verify password
      const ok = await verifyPassword(password, account.passwordHash);
      if (!ok) {
        return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
      }
    } else {
      // First login: open registration — create account with the chosen password
      const passwordHash = await hashPassword(password);
      await prisma.userAccount.create({ data: { userName: name, passwordHash } });
    }

    // Replace existing web-session key for this user (one active session at a time)
    await prisma.apiKey.deleteMany({
      where: { createdBy: name, name: 'web-session' },
    });

    // Generate new personal API key (kept for backwards-compat with existing clients)
    const rawKey = `ps_key_${crypto.randomBytes(24).toString('hex')}`;
    const keyPrefix = rawKey.slice(0, 15);
    const salt = crypto.randomBytes(16);
    const keyHash = await new Promise<string>((resolve, reject) => {
      crypto.scrypt(rawKey, salt, 64, (err, dk) => {
        if (err) reject(err);
        else resolve(`${salt.toString('hex')}:${dk.toString('hex')}`);
      });
    });

    await prisma.apiKey.create({
      data: {
        name: 'web-session',
        keyHash,
        keyPrefix,
        permissions: ['read', 'write'],
        createdBy: name,
      },
    });

    // Issue JWT access token + refresh token
    const accessToken = await signAccessToken(name);

    const jti = crypto.randomBytes(16).toString('hex');
    const rawRefresh = `${jti}.${crypto.randomBytes(24).toString('hex')}`;
    const rfHash = await hashToken(rawRefresh);
    const rfExpiry = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);

    // Clean up expired refresh tokens for this user before creating a new one
    await prisma.refreshToken.deleteMany({
      where: { userName: name, expiresAt: { lt: new Date() } },
    });

    await prisma.refreshToken.create({
      data: { id: jti, userName: name, tokenHash: rfHash, expiresAt: rfExpiry },
    });

    const isFirstLogin = !account;
    const response = NextResponse.json({
      success: true,
      userName: name,
      isFirstLogin,
      key: rawKey,
      accessToken,
      refreshToken: rawRefresh,
    });

    // httpOnly: JS cannot read or tamper with this cookie
    response.cookies.set('plansync-apikey', rawKey, {
      path: '/',
      maxAge: 31536000,
      sameSite: 'lax',
      httpOnly: true,
    });
    // Non-httpOnly: server components (Next.js RSC) read this for display/filtering
    response.cookies.set('plansync-user', name, {
      path: '/',
      maxAge: 31536000,
      sameSite: 'lax',
    });
    // Refresh token in httpOnly cookie scoped to the refresh endpoint
    response.cookies.set('plansync-refresh', rawRefresh, {
      path: '/api/auth/refresh',
      maxAge: REFRESH_TTL_SECONDS,
      sameSite: 'lax',
      httpOnly: true,
    });

    return response;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Login error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

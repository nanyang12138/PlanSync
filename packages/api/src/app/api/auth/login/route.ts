import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';

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
      // First login (bootstrap): verify against PLANSYNC_SECRET
      const secret = process.env.PLANSYNC_SECRET;
      if (!secret || password !== secret) {
        return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
      }
      // Create account with this password as initial password
      const passwordHash = await hashPassword(password);
      await prisma.userAccount.create({ data: { userName: name, passwordHash } });
    }

    // Replace existing web-session key for this user (one active session at a time)
    await prisma.apiKey.deleteMany({
      where: { createdBy: name, name: 'web-session' },
    });

    // Generate new personal API key
    const rawKey = `ps_key_${crypto.randomBytes(24).toString('hex')}`;
    const keyPrefix = rawKey.slice(0, 15);
    const salt = crypto.randomBytes(16);
    const keyHash = await new Promise<string>((resolve, reject) => {
      crypto.scrypt(rawKey, salt, 64, (err, dk) => {
        if (err) reject(err);
        else resolve(`${salt.toString('hex')}:${dk.toString('hex')}`);
      });
    });

    // Omit projectId so Prisma leaves the column NULL (global web-session key)
    await prisma.apiKey.create({
      data: {
        name: 'web-session',
        keyHash,
        keyPrefix,
        permissions: ['read', 'write'],
        createdBy: name,
      },
    });

    const isFirstLogin = !account;
    const response = NextResponse.json({ success: true, userName: name, isFirstLogin });

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

    return response;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Login error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

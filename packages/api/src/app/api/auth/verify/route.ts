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

// Credential check + account creation for new users.
// Does NOT create or delete web-session API keys — safe for CLI use without invalidating browser sessions.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userName, password } = body as { userName?: string; password?: string };

    if (!userName?.trim() || !password) {
      return NextResponse.json({ error: 'userName and password required' }, { status: 400 });
    }

    const name = userName.trim();
    const account = await prisma.userAccount.findUnique({ where: { userName: name } });

    if (!account) {
      // First login via CLI: create account without touching web-session keys
      const passwordHash = await hashPassword(password);
      await prisma.userAccount.create({ data: { userName: name, passwordHash } });
      return NextResponse.json({ success: true, userName: name, isNewUser: true });
    }

    const ok = await verifyPassword(password, account.passwordHash);
    if (!ok) {
      return NextResponse.json(
        { success: false, error: 'Invalid username or password' },
        { status: 401 },
      );
    }

    return NextResponse.json({ success: true, userName: name });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

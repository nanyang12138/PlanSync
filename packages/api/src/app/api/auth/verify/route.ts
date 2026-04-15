import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';

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

// Read-only credential check — does NOT create or delete API keys.
// Used by CLI tools (bin/plansync) to verify credentials without invalidating browser sessions.
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
      return NextResponse.json({ success: false, error: 'User not found' }, { status: 401 });
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

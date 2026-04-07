import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import path from 'path';
import { prisma } from '@/lib/prisma';

function verifyLinuxPassword(userName: string, password: string): boolean {
  const pamAuth = path.join(process.cwd(), 'pam_auth');
  const result = spawnSync(pamAuth, [userName], {
    input: password,
    timeout: 5000,
  });
  return result.status === 0;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userName, password } = body as { userName?: string; password?: string };

    if (!userName?.trim() || !password) {
      return NextResponse.json({ error: 'userName and password required' }, { status: 400 });
    }

    if (!verifyLinuxPassword(name, password)) {
      return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
    }

    const name = userName.trim();

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

    const response = NextResponse.json({ success: true, userName: name });

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

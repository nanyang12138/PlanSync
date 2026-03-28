import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';

export async function GET(req: NextRequest) {
  try {
    const auth = await authenticate(req);
    const projectId = req.nextUrl.searchParams.get('projectId');
    if (!projectId)
      return NextResponse.json({ error: { message: 'projectId required' } }, { status: 400 });

    await requireProjectRole(auth, projectId);

    const keys = await prisma.apiKey.findMany({
      where: { projectId, createdBy: auth.userName },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        permissions: true,
        createdAt: true,
        lastUsedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json({ data: keys });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await authenticate(req);
    const body = await req.json();
    const { projectId, name, permissions = ['read', 'write'] } = body;
    if (!projectId || !name) {
      return NextResponse.json(
        { error: { message: 'projectId and name required' } },
        { status: 400 },
      );
    }

    await requireProjectRole(auth, projectId);

    // Generate a random API key
    const rawKey = `ps_key_${crypto.randomBytes(24).toString('hex')}`;
    const keyPrefix = rawKey.slice(0, 15);

    // Hash the key using scrypt (Node built-in, no native deps)
    const salt = crypto.randomBytes(16);
    const keyHash = await new Promise<string>((resolve, reject) => {
      crypto.scrypt(rawKey, salt, 64, (err, derivedKey) => {
        if (err) reject(err);
        else resolve(salt.toString('hex') + ':' + derivedKey.toString('hex'));
      });
    });

    const apiKey = await prisma.apiKey.create({
      data: { projectId, name, keyHash, keyPrefix, permissions, createdBy: auth.userName },
    });

    return NextResponse.json(
      {
        data: {
          id: apiKey.id,
          name: apiKey.name,
          key: rawKey,
          keyPrefix,
          permissions,
          createdAt: apiKey.createdAt,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

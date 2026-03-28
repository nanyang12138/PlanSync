import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { AppError, ErrorCode } from '@plansync/shared';
import { prisma } from './prisma';

export interface AuthContext {
  userName: string;
  projectRole?: 'owner' | 'developer';
}

async function verifyApiKey(
  rawKey: string,
): Promise<{ userName: string; projectId: string } | null> {
  const prefix = rawKey.slice(0, 15);
  const keys = await prisma.apiKey.findMany({ where: { keyPrefix: prefix } });

  for (const key of keys) {
    const [saltHex, hashHex] = key.keyHash.split(':');
    const salt = Buffer.from(saltHex, 'hex');
    const isValid = await new Promise<boolean>((resolve) => {
      crypto.scrypt(rawKey, salt, 64, (err, derivedKey) => {
        if (err) resolve(false);
        else resolve(derivedKey.toString('hex') === hashHex);
      });
    });

    if (isValid) {
      await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
      return { userName: key.createdBy, projectId: key.projectId };
    }
  }
  return null;
}

export async function authenticate(req: NextRequest): Promise<AuthContext> {
  const authDisabled = process.env.AUTH_DISABLED === 'true';
  const qpToken = req.nextUrl.searchParams.get('token');
  const qpUser = req.nextUrl.searchParams.get('user');

  const authHeader = req.headers.get('authorization');
  const tokenFromHeader = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = tokenFromHeader ?? qpToken;

  if (token?.startsWith('ps_key_')) {
    const apiAuth = await verifyApiKey(token);
    if (!apiAuth) {
      throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid API key');
    }
    return { userName: apiAuth.userName };
  }

  if (authDisabled) {
    const userName = req.headers.get('x-user-name') || qpUser || 'anonymous';
    return { userName };
  }

  if (!token) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 'Missing or invalid Authorization header');
  }

  const secret = process.env.PLANSYNC_SECRET;

  if (token !== secret) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid token');
  }

  const userName = req.headers.get('x-user-name') ?? qpUser;
  if (!userName) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 'Missing X-User-Name header');
  }

  return { userName };
}

export async function requireProjectRole(
  auth: AuthContext,
  projectId: string,
  requiredRole?: 'owner',
): Promise<AuthContext> {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_name: { projectId, name: auth.userName } },
  });

  if (!member) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      `User "${auth.userName}" is not a member of this project`,
    );
  }

  if (requiredRole === 'owner' && member.role !== 'owner') {
    throw new AppError(ErrorCode.FORBIDDEN, 'Only project owners can perform this action');
  }

  return { ...auth, projectRole: member.role as 'owner' | 'developer' };
}

import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { AppError, ErrorCode } from '@plansync/shared';
import { prisma } from './prisma';

export interface AuthContext {
  userName: string;
  projectRole?: 'owner' | 'developer';
}

// Password verification (same scrypt scheme as login/route.ts)
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

// Cache successful password verifications for 5 min to avoid scrypt on every API call
const _pwCache = new Map<string, { user: string; exp: number }>();

/** Remove all cached entries for a user. Call after a successful password change. */
export function invalidatePasswordCache(userName: string): void {
  for (const key of _pwCache.keys()) {
    if (key.startsWith(`${userName}:`)) _pwCache.delete(key);
  }
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

  // Master delegation: PLANSYNC_SECRET lets the server owner act as any registered user.
  // Used for multi-user simulation in dev/testing. Requires a non-default secret value.
  const masterSecret = process.env.PLANSYNC_SECRET;
  if (masterSecret && masterSecret !== 'dev-secret' && token === masterSecret) {
    const userName = req.headers.get('x-user-name') || qpUser;
    if (!userName) {
      throw new AppError(
        ErrorCode.UNAUTHORIZED,
        'X-User-Name header required with delegation token',
      );
    }
    // Skip DB check when AUTH_DISABLED=true (test environments don't register accounts)
    if (!authDisabled) {
      const exists = await prisma.userAccount.findFirst({ where: { userName } });
      if (!exists) {
        throw new AppError(ErrorCode.UNAUTHORIZED, `Delegation target "${userName}" not found`);
      }
    }
    return { userName };
  }

  // Allow login password as Bearer token (each user sets PLANSYNC_API_KEY = their password).
  // Identity comes from X-User-Name header (set by bin/plansync from $USER).
  if (token && !token.startsWith('ps_key_')) {
    const userName = req.headers.get('x-user-name');
    if (userName) {
      const cacheKey = `${userName}:${token}`;
      const hit = _pwCache.get(cacheKey);
      if (hit && hit.exp > Date.now()) {
        return { userName: hit.user };
      }
      const account = await prisma.userAccount.findUnique({ where: { userName } });
      if (account && (await verifyPassword(token, account.passwordHash))) {
        _pwCache.set(cacheKey, { user: userName, exp: Date.now() + 5 * 60_000 });
        return { userName };
      }
    }
  }

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

  throw new AppError(ErrorCode.UNAUTHORIZED, 'Missing or invalid Authorization header');
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

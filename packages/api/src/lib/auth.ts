import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { AppError, ErrorCode } from '@plansync/shared';
import { prisma } from './prisma';
import { enterRequestContextFromHeaders } from './request-context';

export interface AuthContext {
  userName: string;
  projectRole?: 'owner' | 'developer';
  execRunId?: string;
  /**
   * When the caller authenticated with an API key that was issued for a
   * specific project (e.g. exec-scoped keys), this carries the issuing
   * project so cross-project access can be rejected by `requireProjectRole`.
   * Undefined for password Bearer / master delegation / non-scoped keys.
   */
  keyProjectId?: string;
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
): Promise<{ userName: string; projectId: string | null; execRunId: string | null } | null> {
  const prefix = rawKey.slice(0, 15);
  const keys = await prisma.apiKey.findMany({ where: { keyPrefix: prefix } });

  for (const key of keys) {
    const [saltHex, hashHex] = key.keyHash.split(':');
    const salt = Buffer.from(saltHex, 'hex');
    const isValid = await new Promise<boolean>((resolve) => {
      crypto.scrypt(rawKey, salt, 64, (err, derivedKey) => {
        if (err) {
          resolve(false);
          return;
        }
        const expected = Buffer.from(hashHex, 'hex');
        resolve(
          derivedKey.length === expected.length && crypto.timingSafeEqual(derivedKey, expected),
        );
      });
    });

    if (isValid) {
      if (key.expiresAt && key.expiresAt.getTime() < Date.now()) {
        return null;
      }
      await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
      return { userName: key.createdBy, projectId: key.projectId, execRunId: key.execRunId };
    }
  }
  return null;
}

export async function authenticate(req: NextRequest): Promise<AuthContext> {
  // R-111: every authenticated route enters the request context once, so all
  // downstream logger calls (drift engine, webhooks, prisma helpers) inherit
  // the same correlation id without per-route wiring.
  enterRequestContextFromHeaders(req.headers);

  const authDisabled = process.env.AUTH_DISABLED === 'true';
  const qpToken = req.nextUrl.searchParams.get('token');
  const qpUser = req.nextUrl.searchParams.get('user');

  const authHeader = req.headers.get('authorization');
  const tokenFromHeader = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const cookieKey = req.cookies.get('plansync-apikey')?.value ?? null;
  const token = tokenFromHeader ?? qpToken ?? cookieKey;

  // Master delegation: PLANSYNC_SECRET lets the server owner act as any registered user.
  // Used for multi-user simulation in dev/testing. Requires a non-default, non-empty
  // secret value (validated at boot in production via env.ts).
  const masterSecret = process.env.PLANSYNC_SECRET;
  const masterSecretUsable =
    !!masterSecret && masterSecret !== 'dev-secret' && masterSecret.length >= 8;
  if (masterSecretUsable && token === masterSecret) {
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
  //
  // R-014: Password-as-Bearer is a development/test convenience only. In
  // production it would cache the plaintext password in memory for 5 minutes
  // on every node that serves a request, and force every CLI to ship the
  // user's login password as a long-lived API token. Production deployments
  // must mint scoped `ps_key_*` keys instead, so we gate the entire branch
  // (cache lookup included) on `NODE_ENV !== 'production'`.
  const passwordBearerAllowed = process.env.NODE_ENV !== 'production';
  if (passwordBearerAllowed && token && !token.startsWith('ps_key_')) {
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
    return {
      userName: apiAuth.userName,
      ...(apiAuth.execRunId ? { execRunId: apiAuth.execRunId } : {}),
      ...(apiAuth.projectId ? { keyProjectId: apiAuth.projectId } : {}),
    };
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
  // Reject cross-project use of an exec-scoped API key. The key was minted
  // for one specific run inside one specific project; it must never grant
  // access to a different project regardless of the caller's membership
  // elsewhere. Non-exec keys keep their previous (looser) behaviour to
  // avoid breaking unscoped owner keys that span a single workspace.
  if (auth.execRunId && auth.keyProjectId && auth.keyProjectId !== projectId) {
    throw new AppError(ErrorCode.FORBIDDEN, 'Exec-scoped API key is bound to a different project');
  }

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

/**
 * Reject when caller is using an exec-scoped API key (issued for a specific
 * execution run). Used to block task / plan creation from Genie sessions
 * spawned by /exec or /worker, even when those sessions try to bypass MCP
 * via raw bash + curl.
 */
export function requireNotExecScoped(auth: AuthContext): void {
  if (auth.execRunId) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      'Exec-scoped session cannot create tasks or plan versions. ' +
        'Use plansync_plan_suggest to propose a plan change instead.',
    );
  }
}

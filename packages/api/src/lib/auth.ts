import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { AppError, ErrorCode } from '@plansync/shared';
import { prisma } from './prisma';
import { enterRequestContextFromHeaders } from './request-context';
import {
  MASTER_ERROR_CODES,
  callerIpFromRequest,
  isMasterRouteAllowed,
  isMasterTargetAllowed,
  recordMasterDelegation,
} from './master-audit';
import { logger } from './logger';

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
  /**
   * R-136: set on every successful master-delegation auth (i.e. the caller
   * presented PLANSYNC_SECRET as Bearer + X-User-Name). Carries the
   * audit-row id and the episode's TTL boundary so downstream route layers
   * can render the master mode in their logs / responses without re-deriving
   * it from header inspection.
   *
   * Undefined for password / API-key / AUTH_DISABLED flows.
   */
  masterDelegation?: {
    id: string;
    expiresAt: Date;
  };
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

  // Master delegation: PLANSYNC_SECRET lets the server owner act as any
  // registered user. R-136 wraps this path with four abuse controls:
  // allow / deny lists, per-route allowlist, TTL, audit trail. The escape
  // hatch PLANSYNC_MASTER_LEGACY=true skips all four (dev-only — env.ts
  // refuses that flag in production).
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

    // Skip DB check when AUTH_DISABLED=true (test environments don't register accounts).
    if (!authDisabled) {
      const exists = await prisma.userAccount.findFirst({ where: { userName } });
      if (!exists) {
        throw new AppError(ErrorCode.UNAUTHORIZED, `Delegation target "${userName}" not found`);
      }
    }

    // R-136 escape hatch — explicit opt-out of all abuse controls.
    if (process.env.PLANSYNC_MASTER_LEGACY === 'true') {
      logger.warn(
        { targetUser: userName, route: `${req.method} ${req.nextUrl.pathname}` },
        'R-136: PLANSYNC_MASTER_LEGACY active — bypassing audit / allow / deny / TTL',
      );
      return { userName };
    }

    // R-136 (1) — target allow / deny list.
    if (!isMasterTargetAllowed(userName)) {
      logger.warn(
        {
          targetUser: userName,
          callerIp: callerIpFromRequest(req),
          route: `${req.method} ${req.nextUrl.pathname}`,
        },
        'R-136: master delegation refused (target not allowed)',
      );
      throw new AppError(
        ErrorCode.FORBIDDEN,
        `Master delegation to "${userName}" is not permitted on this deployment. ` +
          `Set PLANSYNC_MASTER_ALLOWED_TARGETS to include the target user, or remove it ` +
          `from PLANSYNC_MASTER_DENY_TARGETS.`,
        { code: MASTER_ERROR_CODES.MASTER_TARGET_DENIED },
      );
    }

    // R-136 (3) — per-route allowlist (default-deny). Block dangerous writes
    // before recording the episode so a denied call doesn't pollute the audit
    // table with a row it never used.
    if (!isMasterRouteAllowed(req.method, req.nextUrl.pathname)) {
      logger.warn(
        {
          targetUser: userName,
          callerIp: callerIpFromRequest(req),
          route: `${req.method} ${req.nextUrl.pathname}`,
        },
        'R-136: master delegation refused (route not on master allowlist)',
      );
      throw new AppError(
        ErrorCode.FORBIDDEN,
        `Master delegation cannot drive ${req.method} ${req.nextUrl.pathname}. ` +
          `Master is limited to reads + safe writes (comments, suggestions, drift resolve). ` +
          `Use a real user session for plan / task / member / project / key mutations.`,
        { code: MASTER_ERROR_CODES.FORBIDDEN_MASTER_ROUTE },
      );
    }

    // R-136 (2) + (4) — TTL + audit. Reuse the most recent unexpired row
    // for (callerIp, targetUser) so a chatty agent doesn't generate one
    // audit row per request.
    const ttlMin = Number(process.env.PLANSYNC_MASTER_DELEGATION_TTL_MIN ?? '60');
    const ttlMs = ttlMin * 60 * 1000;
    const callerIp = callerIpFromRequest(req);
    const callerUa = req.headers.get('user-agent') ?? 'unknown';
    const delegation = await recordMasterDelegation({
      callerIp,
      callerUa,
      targetUser: userName,
      routeMethod: req.method,
      routePath: req.nextUrl.pathname,
      ttlMs,
    });

    if (delegation.expiresAt.getTime() <= Date.now()) {
      // Should be impossible because recordMasterDelegation always returns
      // a future expiresAt, but the explicit guard makes the contract clear.
      throw new AppError(
        ErrorCode.UNAUTHORIZED,
        'Master delegation expired — drive a fresh episode by presenting the secret again.',
        { code: MASTER_ERROR_CODES.MASTER_DELEGATION_EXPIRED },
      );
    }

    return {
      userName,
      masterDelegation: { id: delegation.id, expiresAt: delegation.expiresAt },
    };
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

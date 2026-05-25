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
// env import keeps the boot-time validation in scope — even if no symbol
// from `env` is referenced here, importing the module triggers
// `validateEnv()` at server start, which is what enforces the production
// rejection of PLANSYNC_MASTER_LEGACY=true (closes #791 #798).
import './env';
import { logger } from './logger';

export interface AuthContext {
  userName: string;
  projectRole?: 'owner' | 'developer';
  /**
   * Closes #762: ProjectMember.type ('human' | 'agent') of the
   * authenticated caller within this project. Set by
   * `requireProjectRole` after the membership lookup, so any route
   * that writes an Activity row can record the correct actorType
   * instead of hardcoding 'human'. Undefined when the call is not
   * scoped to a specific project (no membership lookup happened).
   */
  projectMemberType?: 'human' | 'agent';
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

// R-141: unified in-process cache for successful auth verifications.
//
// Both password-Bearer and `ps_key_*` API keys land here so neither path
// has to re-run scrypt on every request — heartbeats fire every 30 s per
// agent and scrypt is the dominant CPU cost on the API hot path.
//
// Key shape: `sha256(rawToken)` (hex). Hashing the token before caching
// means we never keep the plaintext password / API key in memory longer
// than the single request that produced it. The cache value carries the
// scope (`password` | `apikey`) so `invalidatePasswordCache` can selectively
// evict only the password entries for a given user without touching API
// key entries (which carry their own revocation path).
//
// LRU eviction: insertion order via Map; on hit we delete + re-set so the
// most recently used entries sit at the back and the oldest at the front.
// We cap the cache at AUTH_CACHE_MAX_ENTRIES to bound memory in pathological
// scenarios (one entry per unique key seen in any 5-minute window).
type AuthCacheEntry =
  | {
      scope: 'password';
      userName: string;
      expiresAt: number;
    }
  | {
      scope: 'apikey';
      userName: string;
      apiKeyId: string;
      projectId: string | null;
      execRunId: string | null;
      /**
       * Cache TTL — when this entry should be evicted regardless of the
       * underlying ApiKey row. Capped at 5 min so a revoked key can't keep
       * authenticating forever; also gives a fresh DB read enough time to
       * reflect any flips in `expiresAt` / row deletion.
       */
      expiresAt: number;
      /**
       * Mirrors the ApiKey row's own `expiresAt` (epoch ms; null = no
       * row-level expiry). We carry it in the cache so a key that was
       * still valid when first verified but has since been forcibly
       * expired (admin revocation, exec session ending early) is rejected
       * on the very next call instead of riding out the cache TTL. Without
       * this, exec-scoped-keys.test.ts > "expired scoped key is rejected
       * as invalid" would observe a stale 200/403 because a previous test
       * in the same file already populated the cache.
       */
      apiKeyExpiresAt: number | null;
    };

const AUTH_CACHE_TTL_MS = 5 * 60_000;
const AUTH_CACHE_MAX_ENTRIES = 10_000;
const _authCache = new Map<string, AuthCacheEntry>();

function authCacheKey(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function authCacheGet(rawToken: string): AuthCacheEntry | null {
  const key = authCacheKey(rawToken);
  const hit = _authCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    _authCache.delete(key);
    return null;
  }
  // Bump LRU recency without resetting TTL — entries still expire 5 min
  // after they were verified, so a stolen token can't keep itself alive
  // by being constantly used.
  _authCache.delete(key);
  _authCache.set(key, hit);
  return hit;
}

function authCacheSet(rawToken: string, entry: AuthCacheEntry): void {
  const key = authCacheKey(rawToken);
  // Refresh the entry first so it lands at the back of the insertion
  // order, then enforce the cap by evicting from the front if needed.
  _authCache.delete(key);
  _authCache.set(key, entry);
  while (_authCache.size > AUTH_CACHE_MAX_ENTRIES) {
    const oldest = _authCache.keys().next().value;
    if (!oldest) break;
    _authCache.delete(oldest);
  }
}

/** Remove all cached entries for a user. Call after a successful password change. */
export function invalidatePasswordCache(userName: string): void {
  for (const [key, entry] of _authCache) {
    if (entry.scope === 'password' && entry.userName === userName) {
      _authCache.delete(key);
    }
  }
}

/**
 * R-141: drop every cached API-key principal that points at the given
 * ApiKey row. Call after revoking / rotating / forcibly expiring a row so
 * the next authenticate() goes back to the DB and observes the new state
 * instead of riding out the cache TTL.
 */
export function invalidateApiKeyCacheByApiKeyId(apiKeyId: string): void {
  for (const [key, entry] of _authCache) {
    if (entry.scope === 'apikey' && entry.apiKeyId === apiKeyId) {
      _authCache.delete(key);
    }
  }
}

/**
 * R-141: drop every cached API-key principal scoped to the given execution
 * run. Used by /exec-sessions/revoke-token (and tests that simulate the
 * revoke path via direct DB writes) so the next call after a revoke
 * doesn't keep authenticating off the cache.
 */
export function invalidateApiKeyCacheByExecRunId(execRunId: string): void {
  for (const [key, entry] of _authCache) {
    if (entry.scope === 'apikey' && entry.execRunId === execRunId) {
      _authCache.delete(key);
    }
  }
}

/**
 * Test-only: blow away every cached auth verification so individual test
 * cases start with a known-empty cache. Production code never calls this —
 * eviction is driven by TTL + LRU instead.
 */
export function _resetAuthCacheForTests(): void {
  _authCache.clear();
}

/** Test-only: number of live entries in the unified auth cache. */
export function _authCacheSizeForTests(): number {
  return _authCache.size;
}

// R-141: kicks off a background `lastUsedAt` write without making the
// request wait on it. We swallow errors because failure here just means
// we miss one freshness tick on the apiKey row — the caller should never
// be punished for it.
function bumpLastUsedAtAsync(apiKeyId: string): void {
  void prisma.apiKey
    .update({ where: { id: apiKeyId }, data: { lastUsedAt: new Date() } })
    .catch(() => {
      /* best-effort */
    });
}

async function verifyApiKey(
  rawKey: string,
): Promise<{ userName: string; projectId: string | null; execRunId: string | null } | null> {
  // R-141: hot path. A repeated auth with the same key — e.g. heartbeat
  // every 30 s, MCP polling, web UI fanning out parallel requests — should
  // never re-run scrypt. We hash the raw key with sha256 to look it up in
  // the unified auth cache and return the cached principal directly. The
  // `lastUsedAt` bump still happens, but asynchronously so the request
  // doesn't wait on a row write.
  const cached = authCacheGet(rawKey);
  if (cached && cached.scope === 'apikey') {
    if (cached.apiKeyExpiresAt !== null && cached.apiKeyExpiresAt < Date.now()) {
      // Row-level expiry overrides the cache. Drop the entry and fall
      // through to a fresh verify, which will re-check `expiresAt` against
      // the DB row and return null (→ 401 from the caller).
      _authCache.delete(authCacheKey(rawKey));
    } else {
      bumpLastUsedAtAsync(cached.apiKeyId);
      return {
        userName: cached.userName,
        projectId: cached.projectId,
        execRunId: cached.execRunId,
      };
    }
  }

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
      authCacheSet(rawKey, {
        scope: 'apikey',
        userName: key.createdBy,
        apiKeyId: key.id,
        projectId: key.projectId,
        execRunId: key.execRunId,
        expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
        apiKeyExpiresAt: key.expiresAt ? key.expiresAt.getTime() : null,
      });
      bumpLastUsedAtAsync(key.id);
      // R-137: an exec-scoped key without a projectId is dirty data. Exec-scoped
      // keys are minted via /exec-sessions/issue-token which always sets both
      // execRunId and projectId. Encountering execRunId-without-projectId
      // means either: a hand-crafted row in the DB, a legacy seed predating
      // R-011, or a migration bug. Surface it loudly so ops can audit; the
      // call still proceeds (requireProjectRole rejects on the same condition).
      if (key.execRunId && !key.projectId) {
        logger.warn(
          {
            apiKeyId: key.id,
            execRunId: key.execRunId,
            createdBy: key.createdBy,
          },
          'R-137: exec-scoped API key has execRunId without projectId — dirty data, will be rejected by requireProjectRole',
        );
      }
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
    // env.ts's superRefine block REFUSES TO BOOT in production when
    // PLANSYNC_MASTER_LEGACY=true, so the runtime read here is safely
    // dev/test-only (closes #791 #798). We read process.env directly
    // (not the validated `env` object) so tests can flip the flag
    // mid-run without re-importing the env singleton.
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
    // audit row per request. The TTL value is validated at boot by
    // env.ts (zod coerce-positive-number), and we additionally guard at
    // call time so a malformed mid-process override (or NODE_ENV=test
    // tests that bypass env validation) never drives TTL=NaN→0
    // and instantly expires every delegation (closes #788).
    const ttlMinRaw = Number(process.env.PLANSYNC_MASTER_DELEGATION_TTL_MIN);
    const ttlMin = Number.isFinite(ttlMinRaw) && ttlMinRaw > 0 ? ttlMinRaw : 60;
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
      // R-141: unified auth cache. We still bind the cache hit to the
      // userName from the request header so a stolen token presented under
      // a different `x-user-name` doesn't sneak past on a sibling user's
      // cache entry — same guard the previous keyed-by-userName cache
      // provided.
      const cached = authCacheGet(token);
      if (cached && cached.scope === 'password' && cached.userName === userName) {
        return { userName: cached.userName };
      }
      const account = await prisma.userAccount.findUnique({ where: { userName } });
      if (account && (await verifyPassword(token, account.passwordHash))) {
        authCacheSet(token, {
          scope: 'password',
          userName,
          expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
        });
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
  // R-011 + R-137: cross-project enforcement for project-scoped API keys.
  //
  // Two independent guards, both must trip 403:
  //   1. The key carries a projectId that doesn't match the request target.
  //      This covers exec-scoped keys (R-011 original scenario) AND any
  //      non-exec project-scoped key that gets pointed at a sibling project.
  //      Previously this only fired when execRunId was ALSO set, which
  //      meant a legacy ApiKey row with projectId-but-no-execRunId silently
  //      bypassed the scope check (R-137 root cause).
  //
  //   2. The key carries an execRunId but no projectId. Every exec-scoped
  //      key minted via /exec-sessions/issue-token sets both fields; seeing
  //      execRunId-without-projectId means tampered or migrated-broken data
  //      and must not be trusted to authorise anything beyond a single
  //      project. We refuse the request and let ops investigate (the
  //      warning is emitted in verifyApiKey).
  if (auth.keyProjectId && auth.keyProjectId !== projectId) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      auth.execRunId
        ? 'Exec-scoped API key is bound to a different project'
        : 'Project-scoped API key is bound to a different project',
    );
  }
  if (auth.execRunId && !auth.keyProjectId) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      'Exec-scoped API key is missing its project binding (dirty data)',
    );
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

  return {
    ...auth,
    projectRole: member.role as 'owner' | 'developer',
    // Closes #762: surface the membership type so route handlers can
    // record the correct Activity.actorType. ProjectMember.type is
    // a free-form string in Prisma but the documented domain is
    // 'human' | 'agent'; coerce defensively.
    projectMemberType: member.type === 'agent' ? 'agent' : 'human',
  };
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

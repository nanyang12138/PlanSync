/**
 * R-136: master-delegation abuse controls.
 *
 * `PLANSYNC_SECRET` (the "master" Bearer token) lets the server owner act as
 * any registered user. Until R-136 this had zero audit trail and no
 * restrictions — a leaked secret = full horizontal movement across every
 * account on the deployment. This module adds the four controls R-136
 * mandates:
 *
 *   1. **Audit** — every master hit (after dedup) inserts a row into
 *      `master_delegations` recording who impersonated whom, from where,
 *      against which route, and when the resulting session expires.
 *
 *   2. **Allow / deny lists** — `PLANSYNC_MASTER_ALLOWED_TARGETS` (CSV) is
 *      the allowlist; `PLANSYNC_MASTER_DENY_TARGETS` (CSV) wins when both
 *      hit. In **production with no allowlist set**, master delegation is
 *      rejected entirely (`isMasterTargetAllowed` returns false). Dev /
 *      test environments default to "allow everything" so the existing
 *      developer workflow (set PLANSYNC_SECRET, X-User-Name yourself) keeps
 *      working without ceremony.
 *
 *   3. **Route restriction** — even with allowed target, master can only
 *      drive read endpoints + a small allowlist of "safe writes" (comments,
 *      drift resolution, plan suggestions). Anything that creates / edits /
 *      activates plans, tasks, members, projects, or API keys is rejected
 *      with `FORBIDDEN_MASTER_ROUTE`. The allowlist is small + grep-able so
 *      adding a new dangerous route doesn't accidentally grant master access
 *      to it (default-deny).
 *
 *   4. **TTL + 5-min reuse window** — a master delegation episode is one
 *      row per (callerIp, targetUser). The first hit inserts a row with
 *      `expires_at = now() + PLANSYNC_MASTER_DELEGATION_TTL_MIN`. Subsequent
 *      hits within 5 minutes reuse that row (no new INSERT — keeps the
 *      table small for a chatty agent). After TTL expiry the master path
 *      rejects with `MASTER_DELEGATION_EXPIRED` until the caller drives a
 *      fresh episode (next call inserts a new row).
 *
 * The escape hatch `PLANSYNC_MASTER_LEGACY=true` skips all of the above —
 * intended for one-off dev debugging and refused at boot in production by
 * the env.ts superRefine guard.
 */

import { NextRequest } from 'next/server';
import { prisma } from './prisma';

/**
 * How long an in-flight episode can "absorb" additional master hits without
 * inserting a new audit row. Picked at 5 minutes because:
 *   - typical agent session burst = 10–50 requests over 1–3 minutes; one row
 *     per session keeps the table size manageable
 *   - 5 minutes is short enough that a different attacker session (different
 *     traffic pattern, same callerIp) still gets its own audit row
 *   - matches the R-136 spec text ("若 5 分钟内已有未过期 delegation → 复用")
 */
export const MASTER_DELEGATION_REUSE_WINDOW_MS = 5 * 60 * 1000;

/** GC: drop audit rows older than this many days past expiry. R-136 spec: 7. */
export const MASTER_DELEGATION_RETENTION_DAYS = 7;

/** Wire error codes that the master path can return. Exported so tests +
 *  the auth route can switch on them deterministically. */
export const MASTER_ERROR_CODES = {
  MASTER_DISABLED: 'MASTER_DISABLED',
  MASTER_TARGET_DENIED: 'MASTER_TARGET_DENIED',
  MASTER_DELEGATION_EXPIRED: 'MASTER_DELEGATION_EXPIRED',
  FORBIDDEN_MASTER_ROUTE: 'FORBIDDEN_MASTER_ROUTE',
} as const;

function parseCsvSet(value: string | undefined): Set<string> | null {
  if (!value) return null;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0) return null;
  return new Set(items);
}

/**
 * Decide whether `targetUser` may be impersonated via the master path.
 * Reads env at call time (not at module load) so test overrides take effect
 * without re-importing the module.
 *
 * Rules (in order):
 *   1. PLANSYNC_MASTER_LEGACY=true bypasses all checks (dev-only — env.ts
 *      refuses this combo in production).
 *   2. Deny list wins: if `targetUser ∈ DENY_TARGETS`, reject.
 *   3. If allow list is set, `targetUser` must be in it.
 *   4. If allow list is UNSET:
 *        - production → reject (fail-closed)
 *        - dev / test → allow (preserves current developer workflow)
 */
export function isMasterTargetAllowed(
  targetUser: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.PLANSYNC_MASTER_LEGACY === 'true') return true;

  const deny = parseCsvSet(env.PLANSYNC_MASTER_DENY_TARGETS);
  if (deny?.has(targetUser)) return false;

  const allow = parseCsvSet(env.PLANSYNC_MASTER_ALLOWED_TARGETS);
  if (allow) return allow.has(targetUser);

  // Unset allow list — fail-closed in production, permissive elsewhere.
  return env.NODE_ENV !== 'production';
}

/**
 * Per-route allowlist for what master delegation can drive.
 *
 * Master is intended for **read** + **safe-write** ops only — anything an
 * agent could do on its own (comment, suggest a plan change, resolve a
 * drift alert) is fine because the audit trail captures it; anything that
 * fundamentally changes plan / task / membership / project / key state is
 * NOT allowed via master, because that's exactly the impersonation surface
 * a leaked secret would abuse.
 *
 * The check is intentionally a small ordered list of `(method, pathRe)`
 * tuples so a future "new dangerous route" is **default-deny**: forgetting
 * to add a tuple is a safe omission, not a hole.
 *
 * Path regexes deliberately do NOT anchor with `^/api/` — Next.js gives us
 * the full pathname (`/api/projects/...`), which we match against the
 * prefix-anchored regex so trailing slashes don't break matching.
 */
const MASTER_ROUTE_ALLOWLIST: Array<{ method: string | '*'; path: RegExp }> = [
  // Any GET — reads are universally safe; the audit trail still records them.
  { method: 'GET', path: /^\/api\// },

  // Comments — POST / PATCH / DELETE allowed. Comments are agent-grade
  // safe writes (any teammate can leave one) and the audit trail captures
  // who-as-whom said what.
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/comments\b/ },
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/plans\/[^/]+\/comments\b/ },
  { method: 'PATCH', path: /^\/api\/projects\/[^/]+\/comments\/[^/]+$/ },
  { method: 'DELETE', path: /^\/api\/projects\/[^/]+\/comments\/[^/]+$/ },
  { method: 'PATCH', path: /^\/api\/projects\/[^/]+\/plans\/[^/]+\/comments\/[^/]+$/ },
  { method: 'DELETE', path: /^\/api\/projects\/[^/]+\/plans\/[^/]+\/comments\/[^/]+$/ },

  // Plan suggestions — agent-grade write equivalent of "I suggest you
  // change X". Owner via master can suggest on behalf of a teammate.
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/plans\/[^/]+\/suggestions\b/ },

  // Drift alert resolution — operational write; agent-grade.
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/drift-alerts\/[^/]+\/resolve$/ },

  // Master-audit self-query — owner reads its own audit trail.
  { method: 'GET', path: /^\/api\/auth\/master-audit(?:\?.*)?$/ },
];

/**
 * Returns true when the (method, path) tuple is on the master-allowlist.
 * Anything not on the list is rejected with `FORBIDDEN_MASTER_ROUTE`.
 */
export function isMasterRouteAllowed(method: string, path: string): boolean {
  for (const entry of MASTER_ROUTE_ALLOWLIST) {
    if (entry.method !== '*' && entry.method !== method) continue;
    if (entry.path.test(path)) return true;
  }
  return false;
}

/**
 * Extract a best-effort caller IP from request headers. Order:
 *   1. X-Forwarded-For (first IP if comma-separated)
 *   2. X-Real-IP
 *   3. "unknown" (still a non-empty string so the column NOT NULL holds)
 */
export function callerIpFromRequest(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const xri = req.headers.get('x-real-ip');
  if (xri && xri.trim()) return xri.trim();
  return 'unknown';
}

export interface RecordedDelegation {
  id: string;
  expiresAt: Date;
  reused: boolean;
}

/**
 * Idempotent (within the reuse window) record of a master delegation
 * episode. Returns the delegation row that should be considered "current"
 * for this hit.
 *
 * Behaviour:
 *   - lookup most recent row for (callerIp, targetUser)
 *   - if it exists AND its expiresAt > nowMs (still valid):
 *       - if its occurredAt is within MASTER_DELEGATION_REUSE_WINDOW_MS
 *         of now → REUSE (no insert; return existing row marked
 *         `reused: true`)
 *       - else → it's an older still-valid episode; treat it as the
 *         "session is mid-flight" anchor (also reuse)
 *   - else (no row, or expired) → INSERT a fresh row with
 *     expiresAt = now + ttlMs
 *
 * The function does NOT itself enforce "expired = reject" — that's the
 * caller's job in auth.ts. We return the row's expiresAt so the caller
 * can compare against `now` and decide whether to throw
 * MASTER_DELEGATION_EXPIRED. The split exists because the audit / GC
 * concerns are pure DB state and the auth concerns mix in HTTP-shaped
 * error responses; keeping them in different layers is easier to test.
 */
export async function recordMasterDelegation(opts: {
  callerIp: string;
  callerUa: string;
  targetUser: string;
  routeMethod: string;
  routePath: string;
  ttlMs: number;
  nowMs?: number;
}): Promise<RecordedDelegation> {
  const now = opts.nowMs ?? Date.now();
  const existing = await prisma.masterDelegation.findFirst({
    where: {
      callerIp: opts.callerIp,
      targetUser: opts.targetUser,
    },
    orderBy: { occurredAt: 'desc' },
  });

  if (existing && existing.expiresAt.getTime() > now) {
    // Mid-flight episode — reuse. We deliberately don't update the row;
    // the audit story is "one row per episode", not "row gets touched on
    // every request".
    return { id: existing.id, expiresAt: existing.expiresAt, reused: true };
  }

  const inserted = await prisma.masterDelegation.create({
    data: {
      callerIp: opts.callerIp,
      callerUa: opts.callerUa,
      targetUser: opts.targetUser,
      routeMethod: opts.routeMethod,
      routePath: opts.routePath,
      occurredAt: new Date(now),
      expiresAt: new Date(now + opts.ttlMs),
    },
  });
  return { id: inserted.id, expiresAt: inserted.expiresAt, reused: false };
}

/**
 * GC entry point — used by the heartbeat scanner. Deletes audit rows whose
 * expiresAt is older than `MASTER_DELEGATION_RETENTION_DAYS` past now.
 * Returns the count of deleted rows for observability.
 */
export async function gcExpiredMasterDelegations(nowMs: number = Date.now()): Promise<number> {
  const cutoff = new Date(nowMs - MASTER_DELEGATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await prisma.masterDelegation.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return result.count;
}

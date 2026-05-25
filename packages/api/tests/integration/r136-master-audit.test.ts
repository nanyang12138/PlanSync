/**
 * R-136: master-delegation (PLANSYNC_SECRET) abuse controls — integration tests.
 *
 * Covers all five scenarios listed in the R-136 entry's `verification`
 * field plus the per-route allowlist gate and the GC sweeper.
 *
 * Approach:
 *   - Each test sets `process.env.PLANSYNC_SECRET` + the relevant R-136
 *     env vars, then drives `authenticate()` directly (instead of through
 *     a route) because the master gate is what we're testing. Driving
 *     `authenticate` keeps the assertions tight on its thrown AppError
 *     shape — wire-format details are covered by the existing handleApiError
 *     unit tests.
 *   - We restore env state in afterEach so AUTH_DISABLED stays on for
 *     unrelated tests.
 *   - The audit table is cleared between tests so reuse-window logic is
 *     deterministic (otherwise a prior row would mask the insert path).
 *
 * NOTE: AUTH_DISABLED=true is set in tests/setup.ts. The master branch in
 * authenticate() short-circuits the `userAccount` lookup when
 * AUTH_DISABLED is true, so we don't need to seed accounts for these
 * tests; the master allow/deny + route + TTL gates run regardless.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth';
import {
  MASTER_DELEGATION_REUSE_WINDOW_MS,
  MASTER_ERROR_CODES,
  callerIpFromRequest,
  gcExpiredMasterDelegations,
  isMasterRouteAllowed,
  isMasterTargetAllowed,
  recordMasterDelegation,
} from '@/lib/master-audit';

const prisma = new PrismaClient();
const TEST_SECRET = 'r136-test-master-secret-XXXXXXXXXXXX';

interface SavedEnv {
  PLANSYNC_SECRET?: string;
  PLANSYNC_MASTER_ALLOWED_TARGETS?: string;
  PLANSYNC_MASTER_DENY_TARGETS?: string;
  PLANSYNC_MASTER_DELEGATION_TTL_MIN?: string;
  PLANSYNC_MASTER_LEGACY?: string;
  NODE_ENV?: string;
}

function snapshotEnv(): SavedEnv {
  return {
    PLANSYNC_SECRET: process.env.PLANSYNC_SECRET,
    PLANSYNC_MASTER_ALLOWED_TARGETS: process.env.PLANSYNC_MASTER_ALLOWED_TARGETS,
    PLANSYNC_MASTER_DENY_TARGETS: process.env.PLANSYNC_MASTER_DENY_TARGETS,
    PLANSYNC_MASTER_DELEGATION_TTL_MIN: process.env.PLANSYNC_MASTER_DELEGATION_TTL_MIN,
    PLANSYNC_MASTER_LEGACY: process.env.PLANSYNC_MASTER_LEGACY,
    NODE_ENV: process.env.NODE_ENV,
  };
}

function restoreEnv(snap: SavedEnv) {
  const env = process.env as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
}

function makeMasterReq(opts: {
  targetUser: string;
  method?: string;
  path?: string;
  callerIp?: string;
}) {
  const full = new URL(opts.path ?? '/api/projects/p1/comments', 'http://localhost');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${TEST_SECRET}`,
    'x-user-name': opts.targetUser,
    'user-agent': 'vitest-r136',
  };
  if (opts.callerIp) headers['x-forwarded-for'] = opts.callerIp;
  return new NextRequest(full.toString(), {
    method: opts.method ?? 'POST',
    headers,
  });
}

describe('R-136: isMasterTargetAllowed (pure)', () => {
  it('allows everything in dev when allow-list is unset', () => {
    expect(isMasterTargetAllowed('anyone', { NODE_ENV: 'development' })).toBe(true);
  });

  it('rejects everything in production when allow-list is unset (fail-closed)', () => {
    expect(isMasterTargetAllowed('anyone', { NODE_ENV: 'production' })).toBe(false);
  });

  it('honours allow-list', () => {
    const env = {
      NODE_ENV: 'production',
      PLANSYNC_MASTER_ALLOWED_TARGETS: 'alice, bob ,charlie',
    };
    expect(isMasterTargetAllowed('alice', env)).toBe(true);
    expect(isMasterTargetAllowed('bob', env)).toBe(true);
    expect(isMasterTargetAllowed('charlie', env)).toBe(true);
    expect(isMasterTargetAllowed('mallory', env)).toBe(false);
  });

  it('deny-list wins over allow-list', () => {
    const env = {
      NODE_ENV: 'production',
      PLANSYNC_MASTER_ALLOWED_TARGETS: 'alice,bob',
      PLANSYNC_MASTER_DENY_TARGETS: 'bob',
    };
    expect(isMasterTargetAllowed('alice', env)).toBe(true);
    expect(isMasterTargetAllowed('bob', env)).toBe(false);
  });

  it('PLANSYNC_MASTER_LEGACY=true bypasses all checks', () => {
    const env = {
      NODE_ENV: 'production',
      PLANSYNC_MASTER_LEGACY: 'true',
      PLANSYNC_MASTER_DENY_TARGETS: 'alice',
    };
    expect(isMasterTargetAllowed('alice', env)).toBe(true);
  });
});

describe('R-136: isMasterRouteAllowed (pure)', () => {
  it('allows any GET under /api', () => {
    expect(isMasterRouteAllowed('GET', '/api/projects/p1')).toBe(true);
    expect(isMasterRouteAllowed('GET', '/api/projects/p1/tasks')).toBe(true);
    expect(isMasterRouteAllowed('GET', '/api/auth/master-audit')).toBe(true);
  });

  it('allows comment writes', () => {
    expect(isMasterRouteAllowed('POST', '/api/projects/p1/comments')).toBe(true);
    expect(isMasterRouteAllowed('POST', '/api/projects/p1/plans/pl1/comments')).toBe(true);
    expect(isMasterRouteAllowed('PATCH', '/api/projects/p1/comments/c1')).toBe(true);
    expect(isMasterRouteAllowed('DELETE', '/api/projects/p1/comments/c1')).toBe(true);
  });

  it('allows plan suggestions', () => {
    expect(isMasterRouteAllowed('POST', '/api/projects/p1/plans/pl1/suggestions')).toBe(true);
  });

  it('allows drift resolve at the actual route path', () => {
    // Closes #765-class — the real route is `/drifts/{driftId}` (see
    // packages/api/src/app/api/projects/[projectId]/drifts/[driftId]/route.ts).
    // The previous regex looked for a non-existent
    // `/drift-alerts/.../resolve` so master-driven drift resolution
    // silently 403'd in production.
    expect(isMasterRouteAllowed('POST', '/api/projects/p1/drifts/d1')).toBe(true);
    expect(isMasterRouteAllowed('POST', '/api/projects/p1/drift-alerts/d1/resolve')).toBe(false);
  });

  it('rejects plan / task / member / project / key mutations (default-deny)', () => {
    expect(isMasterRouteAllowed('POST', '/api/projects/p1/plans/pl1/propose')).toBe(false);
    expect(isMasterRouteAllowed('POST', '/api/projects/p1/plans/pl1/activate')).toBe(false);
    expect(isMasterRouteAllowed('POST', '/api/projects/p1/plans')).toBe(false);
    expect(isMasterRouteAllowed('PATCH', '/api/projects/p1/plans/pl1')).toBe(false);
    expect(isMasterRouteAllowed('POST', '/api/projects/p1/tasks')).toBe(false);
    expect(isMasterRouteAllowed('DELETE', '/api/projects/p1/tasks/t1')).toBe(false);
    expect(isMasterRouteAllowed('POST', '/api/projects/p1/members')).toBe(false);
    expect(isMasterRouteAllowed('PATCH', '/api/projects/p1')).toBe(false);
    expect(isMasterRouteAllowed('POST', '/api/auth/api-keys')).toBe(false);
  });
});

describe('R-136: callerIpFromRequest (pure)', () => {
  function makeReqWithHeaders(headers: Record<string, string>) {
    return new NextRequest('http://localhost/api/test', { headers });
  }
  it('prefers X-Forwarded-For first IP', () => {
    expect(
      callerIpFromRequest(
        makeReqWithHeaders({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8', 'x-real-ip': '9.9.9.9' }),
      ),
    ).toBe('1.2.3.4');
  });
  it('falls back to X-Real-IP', () => {
    expect(callerIpFromRequest(makeReqWithHeaders({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
  });
  it('falls back to "unknown" when no header', () => {
    expect(callerIpFromRequest(makeReqWithHeaders({}))).toBe('unknown');
  });
});

describe('R-136: recordMasterDelegation (DB)', () => {
  beforeEach(async () => {
    await prisma.masterDelegation.deleteMany();
  });

  it('inserts a fresh row on first hit and computes expiresAt = now + ttl', async () => {
    const now = Date.now();
    const r = await recordMasterDelegation({
      callerIp: '1.2.3.4',
      callerUa: 'test',
      targetUser: 'alice',
      routeMethod: 'POST',
      routePath: '/api/projects/p1/comments',
      ttlMs: 60_000,
      nowMs: now,
    });
    expect(r.reused).toBe(false);
    expect(r.expiresAt.getTime() - now).toBeGreaterThanOrEqual(59_000);
    expect(r.expiresAt.getTime() - now).toBeLessThanOrEqual(61_000);

    const all = await prisma.masterDelegation.findMany({ where: { targetUser: 'alice' } });
    expect(all).toHaveLength(1);
  });

  it('reuses an unexpired row for the same (callerIp, targetUser) within reuse window', async () => {
    const now = Date.now();
    const first = await recordMasterDelegation({
      callerIp: '1.2.3.4',
      callerUa: 'test',
      targetUser: 'alice',
      routeMethod: 'POST',
      routePath: '/api/projects/p1/comments',
      ttlMs: 60 * 60_000, // 60 min
      nowMs: now,
    });
    // 1 minute later — still in reuse window.
    const second = await recordMasterDelegation({
      callerIp: '1.2.3.4',
      callerUa: 'test',
      targetUser: 'alice',
      routeMethod: 'POST',
      routePath: '/api/projects/p1/comments/c1',
      ttlMs: 60 * 60_000,
      nowMs: now + 60_000,
    });
    expect(second.reused).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.expiresAt.getTime()).toBe(first.expiresAt.getTime());

    const all = await prisma.masterDelegation.findMany({ where: { targetUser: 'alice' } });
    expect(all).toHaveLength(1);
  });

  it('inserts a new row after the prior one has expired', async () => {
    const now = Date.now();
    const ttl = 60_000;
    await recordMasterDelegation({
      callerIp: '1.2.3.4',
      callerUa: 'test',
      targetUser: 'alice',
      routeMethod: 'POST',
      routePath: '/api/projects/p1/comments',
      ttlMs: ttl,
      nowMs: now,
    });
    // Past TTL.
    const second = await recordMasterDelegation({
      callerIp: '1.2.3.4',
      callerUa: 'test',
      targetUser: 'alice',
      routeMethod: 'POST',
      routePath: '/api/projects/p1/comments',
      ttlMs: ttl,
      nowMs: now + ttl + 1_000,
    });
    expect(second.reused).toBe(false);

    const all = await prisma.masterDelegation.findMany({
      where: { targetUser: 'alice' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(all).toHaveLength(2);
  });

  it('separates rows by callerIp (different caller = new episode)', async () => {
    const now = Date.now();
    await recordMasterDelegation({
      callerIp: '1.2.3.4',
      callerUa: 'test',
      targetUser: 'alice',
      routeMethod: 'POST',
      routePath: '/api/projects/p1/comments',
      ttlMs: 60 * 60_000,
      nowMs: now,
    });
    const second = await recordMasterDelegation({
      callerIp: '5.6.7.8', // different IP
      callerUa: 'test',
      targetUser: 'alice',
      routeMethod: 'POST',
      routePath: '/api/projects/p1/comments',
      ttlMs: 60 * 60_000,
      nowMs: now,
    });
    expect(second.reused).toBe(false);

    const all = await prisma.masterDelegation.findMany({ where: { targetUser: 'alice' } });
    expect(all).toHaveLength(2);
  });
});

describe('R-136: end-to-end via authenticate()', () => {
  let saved: SavedEnv;

  beforeEach(async () => {
    saved = snapshotEnv();
    process.env.PLANSYNC_SECRET = TEST_SECRET;
    delete process.env.PLANSYNC_MASTER_LEGACY;
    delete process.env.PLANSYNC_MASTER_ALLOWED_TARGETS;
    delete process.env.PLANSYNC_MASTER_DENY_TARGETS;
    process.env.PLANSYNC_MASTER_DELEGATION_TTL_MIN = '60';
    await prisma.masterDelegation.deleteMany();
  });

  afterEach(() => {
    restoreEnv(saved);
  });

  it('VR1: in production without ALLOWED_TARGETS set → 403 MASTER_TARGET_DENIED', async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    const req = makeMasterReq({ targetUser: 'alice' });
    await expect(authenticate(req)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { code: MASTER_ERROR_CODES.MASTER_TARGET_DENIED },
    });
  });

  it('VR2: target on DENY list → 403 MASTER_TARGET_DENIED', async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    process.env.PLANSYNC_MASTER_ALLOWED_TARGETS = 'alice,bob';
    process.env.PLANSYNC_MASTER_DENY_TARGETS = 'bob';
    const req = makeMasterReq({ targetUser: 'bob' });
    await expect(authenticate(req)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { code: MASTER_ERROR_CODES.MASTER_TARGET_DENIED },
    });
  });

  it('VR3: master driving plan_propose → 403 FORBIDDEN_MASTER_ROUTE (no audit row inserted)', async () => {
    const req = makeMasterReq({
      targetUser: 'alice',
      method: 'POST',
      path: '/api/projects/p1/plans/pl1/propose',
    });
    await expect(authenticate(req)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { code: MASTER_ERROR_CODES.FORBIDDEN_MASTER_ROUTE },
    });
    // Denied calls do NOT touch the audit table — keeps storage proportional
    // to allowed traffic only.
    const all = await prisma.masterDelegation.findMany();
    expect(all).toHaveLength(0);
  });

  it('VR4: allowed target + allowed route → returns AuthContext with masterDelegation set and inserts audit row', async () => {
    const req = makeMasterReq({ targetUser: 'alice', callerIp: '10.0.0.1' });
    const auth = await authenticate(req);
    expect(auth.userName).toBe('alice');
    expect(auth.masterDelegation).toBeDefined();
    expect(auth.masterDelegation!.id).toBeTruthy();
    expect(auth.masterDelegation!.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const rows = await prisma.masterDelegation.findMany({ where: { targetUser: 'alice' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].callerIp).toBe('10.0.0.1');
    expect(rows[0].routeMethod).toBe('POST');
    expect(rows[0].routePath).toBe('/api/projects/p1/comments');
  });

  it('VR5a: two master calls within 5min → only one audit row inserted', async () => {
    const req1 = makeMasterReq({ targetUser: 'alice', callerIp: '10.0.0.1' });
    const req2 = makeMasterReq({
      targetUser: 'alice',
      callerIp: '10.0.0.1',
      path: '/api/projects/p1/comments/c2',
    });
    await authenticate(req1);
    await authenticate(req2);
    const rows = await prisma.masterDelegation.findMany({ where: { targetUser: 'alice' } });
    expect(rows).toHaveLength(1);
  });

  it('VR5b: 3rd master call after TTL boundary → new audit row inserted', async () => {
    // Use a 1-minute TTL so we don't need a 60-min sleep. Forge an
    // already-expired row directly so we don't need to actually wait.
    process.env.PLANSYNC_MASTER_DELEGATION_TTL_MIN = '60';

    const past = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago, well past 1h TTL
    await prisma.masterDelegation.create({
      data: {
        callerIp: '10.0.0.1',
        callerUa: 'test',
        targetUser: 'alice',
        routeMethod: 'POST',
        routePath: '/api/projects/p1/comments',
        occurredAt: past,
        expiresAt: new Date(past.getTime() + 60 * 60 * 1000), // expired 1h ago
      },
    });

    const req = makeMasterReq({ targetUser: 'alice', callerIp: '10.0.0.1' });
    const auth = await authenticate(req);
    expect(auth.userName).toBe('alice');

    const rows = await prisma.masterDelegation.findMany({
      where: { targetUser: 'alice' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[1].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('VR6: PLANSYNC_MASTER_LEGACY=true bypasses everything (dev escape hatch)', async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
    process.env.PLANSYNC_MASTER_LEGACY = 'true';
    process.env.PLANSYNC_MASTER_DENY_TARGETS = 'alice'; // would normally reject

    const req = makeMasterReq({
      targetUser: 'alice',
      method: 'POST',
      path: '/api/projects/p1/plans/pl1/propose', // would normally reject
    });
    const auth = await authenticate(req);
    expect(auth.userName).toBe('alice');
    expect(auth.masterDelegation).toBeUndefined();
    // Legacy mode never writes to the audit table.
    const rows = await prisma.masterDelegation.findMany();
    expect(rows).toHaveLength(0);
  });
});

describe('R-136: gcExpiredMasterDelegations', () => {
  beforeEach(async () => {
    await prisma.masterDelegation.deleteMany();
  });

  it('deletes only rows whose expiresAt is older than 7 days past now', async () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    await prisma.masterDelegation.createMany({
      data: [
        // Active — keep
        {
          callerIp: '1',
          callerUa: 't',
          targetUser: 'u1',
          routeMethod: 'POST',
          routePath: '/p',
          occurredAt: new Date(now),
          expiresAt: new Date(now + 60_000),
        },
        // Expired 1 day ago — keep (within retention)
        {
          callerIp: '2',
          callerUa: 't',
          targetUser: 'u2',
          routeMethod: 'POST',
          routePath: '/p',
          occurredAt: new Date(now - 2 * dayMs),
          expiresAt: new Date(now - 1 * dayMs),
        },
        // Expired 8 days ago — delete
        {
          callerIp: '3',
          callerUa: 't',
          targetUser: 'u3',
          routeMethod: 'POST',
          routePath: '/p',
          occurredAt: new Date(now - 10 * dayMs),
          expiresAt: new Date(now - 8 * dayMs),
        },
        // Expired 30 days ago — delete
        {
          callerIp: '4',
          callerUa: 't',
          targetUser: 'u4',
          routeMethod: 'POST',
          routePath: '/p',
          occurredAt: new Date(now - 40 * dayMs),
          expiresAt: new Date(now - 30 * dayMs),
        },
      ],
    });
    const deleted = await gcExpiredMasterDelegations(now);
    expect(deleted).toBe(2);

    const remaining = await prisma.masterDelegation.findMany({
      orderBy: { targetUser: 'asc' },
    });
    expect(remaining.map((r) => r.targetUser)).toEqual(['u1', 'u2']);
  });

  it('reuse window constant matches spec (5 minutes)', () => {
    expect(MASTER_DELEGATION_REUSE_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  // Closes #770s — recordMasterDelegation must honour the documented
  // 5-minute reuse window. Previously it reused any row whose
  // expiresAt was still in the future, which (with the default 60-min
  // TTL) collapsed an entire hour of distinct activity bursts into a
  // single audit row.
  it('inserts a fresh row once the 5-min reuse window has elapsed even if the previous row is still unexpired', async () => {
    await prisma.masterDelegation.deleteMany({ where: { targetUser: 'reuse-window-target' } });

    const now = Date.now();
    const ttlMs = 60 * 60 * 1000; // 60-min default

    // First hit at t=0 — insert.
    const r1 = await recordMasterDelegation({
      callerIp: '10.0.0.99',
      callerUa: 'reuse-window-test',
      targetUser: 'reuse-window-target',
      routeMethod: 'GET',
      routePath: '/api/p',
      ttlMs,
      nowMs: now,
    });
    expect(r1.reused).toBe(false);

    // Second hit at t=2min — within reuse window → REUSE same row.
    const r2 = await recordMasterDelegation({
      callerIp: '10.0.0.99',
      callerUa: 'reuse-window-test',
      targetUser: 'reuse-window-target',
      routeMethod: 'GET',
      routePath: '/api/p',
      ttlMs,
      nowMs: now + 2 * 60 * 1000,
    });
    expect(r2.reused).toBe(true);
    expect(r2.id).toBe(r1.id);

    // Third hit at t=6min — outside 5-min reuse window but the
    // previous row is STILL unexpired (expires at t=60min). Spec says
    // insert a fresh row.
    const r3 = await recordMasterDelegation({
      callerIp: '10.0.0.99',
      callerUa: 'reuse-window-test',
      targetUser: 'reuse-window-target',
      routeMethod: 'GET',
      routePath: '/api/p',
      ttlMs,
      nowMs: now + 6 * 60 * 1000,
    });
    expect(r3.reused).toBe(false);
    expect(r3.id).not.toBe(r1.id);

    const rows = await prisma.masterDelegation.findMany({
      where: { targetUser: 'reuse-window-target' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
  });

  // Closes #765-class — MASTER_ROUTE_ALLOWLIST regression coverage:
  //   - drift resolution endpoint is `/drifts/{driftId}` (not `/drift-alerts/.../resolve`)
  //   - execution_start / heartbeat / complete / task_rebind must be reachable.
  it('master route allowlist matches the actual app routes', () => {
    expect(isMasterRouteAllowed('POST', '/api/projects/p1/drifts/d1')).toBe(true);
    expect(isMasterRouteAllowed('POST', '/api/projects/p1/drift-alerts/d1/resolve')).toBe(false);

    expect(isMasterRouteAllowed('POST', '/api/projects/p1/tasks/t1/runs')).toBe(true);
    expect(isMasterRouteAllowed('PATCH', '/api/projects/p1/tasks/t1/runs/r1')).toBe(true);
    expect(isMasterRouteAllowed('POST', '/api/projects/p1/tasks/t1/rebind')).toBe(true);

    // Sanity: write paths that should still be rejected.
    expect(isMasterRouteAllowed('POST', '/api/projects/p1/tasks')).toBe(false);
    expect(isMasterRouteAllowed('PATCH', '/api/projects/p1')).toBe(false);
    expect(isMasterRouteAllowed('DELETE', '/api/projects/p1')).toBe(false);
  });
});

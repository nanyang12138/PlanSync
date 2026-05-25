import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';

// `testPrisma` is intentionally a SEPARATE PrismaClient from the
// production singleton in `@/lib/prisma`. Both connect to the same
// Postgres so plain CRUD reads / writes against `testPrisma` see the
// same rows the route just wrote — that's the only thing CRUD-style
// assertions need.
//
// Tests that need to *intercept* a production write (e.g. assert that
// `bestEffortAudit` swallows DB errors and continues) must NOT
// `vi.spyOn(testPrisma.X, 'method')` — that spies the test's own
// client and never touches the route's calls. Use the helper
// `spyOnProductionPrisma` below, which spies the actual `@/lib/prisma`
// singleton.
const prisma = new PrismaClient();

export function makeReq(
  url: string,
  opts?: {
    method?: string;
    userName?: string;
    body?: unknown;
    searchParams?: Record<string, string>;
    authToken?: string;
  },
): NextRequest {
  const full = new URL(url, 'http://localhost');
  if (opts?.searchParams) {
    Object.entries(opts.searchParams).forEach(([k, v]) => full.searchParams.set(k, v));
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts?.userName) headers['x-user-name'] = opts.userName;
  if (opts?.authToken) headers['authorization'] = `Bearer ${opts.authToken}`;
  return new NextRequest(full.toString(), {
    method: opts?.method ?? 'GET',
    headers,
    body: opts?.body != null ? JSON.stringify(opts.body) : undefined,
  });
}

export async function createTestProject(owner: string) {
  const p = await prisma.$transaction(async (tx) => {
    const proj = await tx.project.create({
      data: {
        name: `t-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        phase: 'planning',
        createdBy: owner,
      },
    });
    await tx.projectMember.create({
      data: { projectId: proj.id, name: owner, role: 'owner', type: 'human' },
    });
    return proj;
  });
  return { projectId: p.id };
}

export async function addMember(
  projectId: string,
  name: string,
  role: 'owner' | 'developer' = 'developer',
) {
  await prisma.projectMember.create({
    data: { projectId, name, role, type: 'human' },
  });
}

export async function createActivePlan(projectId: string, createdBy: string) {
  // R-048: enforce "at most one active plan per project" via a partial unique
  // index. Direct test inserts must move any prior `active` row to
  // `superseded` first, otherwise the second insert hits a P2002 error.
  return prisma.$transaction(async (tx) => {
    const latest = await tx.plan.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
    });
    await tx.plan.updateMany({
      where: { projectId, status: 'active' },
      data: { status: 'superseded' },
    });
    const p = await tx.plan.create({
      data: {
        projectId,
        title: 'Test Plan',
        goal: 'Test goal',
        scope: 'Test scope',
        version: (latest?.version ?? 0) + 1,
        status: 'active',
        createdBy,
        activatedAt: new Date(),
        activatedBy: createdBy,
      },
    });
    return { planId: p.id, version: p.version };
  });
}

export async function cleanupProject(projectId: string) {
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
}

/**
 * R-134: Mark every non-archived plan on the project as 'superseded' so that
 * a fresh draft can be created. R-036 added a server-side guard preventing
 * more than one active draft per project; the older plans.test.ts cases
 * each inlined this exact updateMany, which silently broke when a new test
 * forgot the snippet (e.g. R-032 PR #42 CI failure).
 *
 * Call this at the top of any test that creates a new draft plan.
 */
export async function resetDraftPlans(projectId: string) {
  await prisma.plan.updateMany({
    where: { projectId, status: { in: ['draft', 'proposed'] } },
    data: { status: 'superseded' },
  });
}

export { prisma as testPrisma };

/**
 * Closes #549 #557 #569 #582 #777 #794 #801 #803 #809 #810 #814 (P0-12).
 *
 * Returns a vitest spy on the PRODUCTION Prisma singleton's method, so
 * tests can intercept the exact calls that route handlers make via
 * `import { prisma } from '@/lib/prisma'`. Without this, every test
 * that did `vi.spyOn(testPrisma.X.method)` was silently asserting
 * against an un-spied path — the spy fired on the test client, the
 * route used the OTHER client, and the "audit-write failure" branch
 * was never actually exercised.
 *
 * Usage:
 *   const restore = await spyOnProductionPrisma('executionRun', 'update', (orig) =>
 *     vi.fn().mockImplementationOnce(() => Promise.reject(new Error('boom')))
 *       .mockImplementation(orig),
 *   );
 *   try { ... } finally { restore(); }
 *
 * The helper deliberately does NOT use `vi.spyOn` directly because
 * Prisma's model proxies (e.g. `prisma.executionRun`) can be
 * regenerated per-access in some Prisma client builds, defeating
 * `vi.spyOn`. Instead we save the original method, swap in the
 * caller-built mock, and `restore()` puts the original back.
 */
export async function spyOnProductionPrisma<
  M extends keyof Awaited<ReturnType<typeof importProductionPrisma>>['prisma'],
  K extends keyof Awaited<ReturnType<typeof importProductionPrisma>>['prisma'][M] & string,
>(
  model: M,
  method: K,
  buildMock: (
    original: Awaited<ReturnType<typeof importProductionPrisma>>['prisma'][M][K],
  ) => Awaited<ReturnType<typeof importProductionPrisma>>['prisma'][M][K],
): Promise<() => void> {
  const { prisma: prodPrisma } = await importProductionPrisma();
  const target = prodPrisma[model] as Record<string, unknown>;
  const original = target[method as string] as Awaited<
    ReturnType<typeof importProductionPrisma>
  >['prisma'][M][K];
  const mock = buildMock(original);
  target[method as string] = mock as unknown;
  return () => {
    target[method as string] = original as unknown;
  };
}

async function importProductionPrisma() {
  return await import('@/lib/prisma');
}

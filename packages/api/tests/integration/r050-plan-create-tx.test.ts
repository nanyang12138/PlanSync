// R-050: plan version generation must be atomic. The POST /plans route was
// running the "no-duplicate-draft" blocking check, the `findFirst latest`
// version lookup, and the `plan.create` insert as three separate prisma
// operations. Two concurrent requests could both compute the same next
// version and race on the `@@unique([projectId, version])` index, leaking a
// raw P2002 to the client. The fix wraps the three steps into a single
// `prisma.$transaction` and retries once on P2002 so the loser falls through
// the R-036 blocking check and receives a clean STATE_CONFLICT.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { POST as plansPost } from '@/app/api/projects/[projectId]/plans/route';
import { prisma } from '@/lib/prisma';
import {
  makeReq,
  createTestProject,
  cleanupProject,
  resetDraftPlans,
  testPrisma,
} from '../helpers/request';

describe('R-050: plan create version race', () => {
  const owner = 'r050-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDraftPlans(projectId);
  });

  const planBody = (title: string) => ({
    title,
    goal: 'g',
    scope: 's',
    constraints: [],
    standards: [],
    deliverables: [],
    openQuestions: [],
    requiredReviewers: [],
  });

  it('retries once when prisma reports a unique-violation (P2002) and ultimately succeeds', async () => {
    const realTx = prisma.$transaction.bind(prisma);
    let calls = 0;
    const spy = vi.spyOn(prisma, '$transaction').mockImplementation(((...args: unknown[]) => {
      calls += 1;
      if (calls === 1) {
        const err = Object.assign(
          new Error('Unique constraint failed on plans_projectId_version_key'),
          {
            code: 'P2002',
            meta: { target: ['projectId', 'version'] },
          },
        );
        return Promise.reject(err);
      }
      return (realTx as (...a: unknown[]) => unknown)(...args);
    }) as unknown as typeof prisma.$transaction);

    const res = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: planBody('R050 retry succeeds'),
      }),
      { params: Promise.resolve({ projectId }) },
    );

    expect(spy).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.status).toBe('draft');
    expect(body.data.title).toBe('R050 retry succeeds');
    expect(body.data.version).toBeGreaterThan(0);

    const fetched = await testPrisma.plan.findUnique({ where: { id: body.data.id } });
    expect(fetched).not.toBeNull();
    expect(fetched?.status).toBe('draft');
  });

  it('does not retry on a non-P2002 error and surfaces it via handleApiError', async () => {
    let calls = 0;
    const spy = vi.spyOn(prisma, '$transaction').mockImplementation((() => {
      calls += 1;
      const err = Object.assign(new Error('boom'), { code: 'P2025' });
      return Promise.reject(err);
    }) as unknown as typeof prisma.$transaction);

    const res = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: planBody('R050 non-p2002 no retry'),
      }),
      { params: Promise.resolve({ projectId }) },
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);
    expect(res.status).not.toBe(201);
  });

  it('after a P2002 retry, the freshly committed blocking draft surfaces as STATE_CONFLICT (not raw CONFLICT)', async () => {
    // Simulate the realistic race outcome: the first transaction "wins" and
    // commits a draft plan. By the time the second transaction's retry runs,
    // the blocking check inside the new transaction now sees that draft and
    // throws AppError(STATE_CONFLICT) — the same response the second caller
    // would have received had the requests been serialized.
    //
    // Use an isolated project so prior tests' superseded plans don't collide
    // on the `@@unique([projectId, version])` constraint when we hand-craft
    // the "winning" draft below.
    const isolated = await createTestProject('r050-owner-isolated');
    const isolatedProjectId = isolated.projectId;
    try {
      const winning = await testPrisma.plan.create({
        data: {
          projectId: isolatedProjectId,
          title: 'R050 winning draft',
          goal: 'g',
          scope: 's',
          version: 1,
          status: 'draft',
          createdBy: 'r050-owner-isolated',
        },
      });

      const realTx = prisma.$transaction.bind(prisma);
      let calls = 0;
      vi.spyOn(prisma, '$transaction').mockImplementation(((...args: unknown[]) => {
        calls += 1;
        if (calls === 1) {
          const err = Object.assign(new Error('Unique constraint failed'), {
            code: 'P2002',
            meta: { target: ['projectId', 'version'] },
          });
          return Promise.reject(err);
        }
        return (realTx as (...a: unknown[]) => unknown)(...args);
      }) as unknown as typeof prisma.$transaction);

      const res = await plansPost(
        makeReq(`/api/projects/${isolatedProjectId}/plans`, {
          method: 'POST',
          userName: 'r050-owner-isolated',
          body: planBody('R050 losing draft'),
        }),
        { params: Promise.resolve({ projectId: isolatedProjectId }) },
      );

      expect(calls).toBe(2);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('STATE_CONFLICT');
      expect(body.error.details?.blockingPlanId).toBe(winning.id);
      expect(body.error.details?.blockingStatus).toBe('draft');
    } finally {
      await cleanupProject(isolatedProjectId);
    }
  });
});

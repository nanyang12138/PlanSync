// R-156: per-deliverable comment threads.
//
// Adds `PlanComment.deliverableId` (nullable FK to `plan_deliverables`).
// The verification contract from REMEDIATION_PLAN.md is:
//
//   vitest：`PlanComment.deliverableId` 在创建评论后正确写入并能按
//   deliverable 过滤拉取
//
// These cases exercise the contract end-to-end through the same route
// handlers the UI calls — schema acceptance, DB row write, GET filter,
// and cross-plan rejection. We deliberately keep them in one test file
// (instead of bolting into `comments.test.ts`) so the new behaviour is
// trivially `grep`-able as "R-156" in CI logs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GET, POST } from '@/app/api/projects/[projectId]/plans/[planId]/comments/route';
import { makeReq, createTestProject, cleanupProject, testPrisma } from '../helpers/request';

describe('R-156: PlanComment.deliverableId per-deliverable thread', () => {
  const owner = `r156-owner-${Date.now()}`;
  let projectId: string;
  let planId: string;
  let deliverableA: string;
  let deliverableB: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const plan = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'R-156 plan',
        goal: 'goal',
        scope: 'scope',
        version: 1,
        status: 'draft',
        createdBy: owner,
      },
    });
    planId = plan.id;
    const [a, b] = await Promise.all([
      testPrisma.planDeliverable.create({
        data: { planId, slug: 'r156-a', title: 'A', body: 'first', refType: 'free' },
      }),
      testPrisma.planDeliverable.create({
        data: { planId, slug: 'r156-b', title: 'B', body: 'second', refType: 'free' },
      }),
    ]);
    deliverableA = a.id;
    deliverableB = b.id;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('POST /comments {content, deliverableId} → 201 and DB row has deliverableId persisted', async () => {
    const res = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'thoughts on A', deliverableId: deliverableA },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.content).toBe('thoughts on A');
    expect(body.data.deliverableId).toBe(deliverableA);

    // Direct DB read — the column must actually be persisted, not just
    // echoed back from the request body. A regression here would mean
    // the timeline UI shows a comment under deliverable A on first load
    // but loses the anchor on the next page refresh.
    const row = await testPrisma.planComment.findUnique({ where: { id: body.data.id } });
    expect(row?.deliverableId).toBe(deliverableA);
  });

  it('POST /comments without deliverableId → row has deliverableId=null (back-compat)', async () => {
    const res = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'plan-level' },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.deliverableId).toBeNull();
  });

  it('POST /comments {deliverableId} from a different plan → 404 (no cross-plan leak)', async () => {
    const otherPlan = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'other plan',
        goal: 'g',
        scope: 's',
        version: 99,
        status: 'draft',
        createdBy: owner,
      },
    });
    const otherDeliverable = await testPrisma.planDeliverable.create({
      data: { planId: otherPlan.id, slug: 'other', title: 'other', body: 'x', refType: 'free' },
    });
    try {
      const res = await POST(
        makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
          method: 'POST',
          userName: owner,
          body: { content: 'cross-plan attempt', deliverableId: otherDeliverable.id },
        }),
        { params: Promise.resolve({ projectId, planId }) },
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toMatch(/Deliverable not found in this plan/);
      // Regression guard: nothing was written to the current plan
      const stray = await testPrisma.planComment.findFirst({
        where: { planId, deliverableId: otherDeliverable.id },
      });
      expect(stray).toBeNull();
    } finally {
      await testPrisma.planDeliverable.delete({ where: { id: otherDeliverable.id } });
      await testPrisma.plan.delete({ where: { id: otherPlan.id } });
    }
  });

  it('GET /comments?deliverableId=A → only the A-anchored comments', async () => {
    // Seed two more comments: one on B, one plan-level. The earlier "A"
    // case already wrote one comment on A so we should see exactly that
    // row plus any additional A-anchored comments we add here.
    await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'B-only comment', deliverableId: deliverableB },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const aSecondRes = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'second A comment', deliverableId: deliverableA },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const aSecondId = (await aSecondRes.json()).data.id;

    const res = await GET(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        userName: owner,
        searchParams: { deliverableId: deliverableA },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = body.data as Array<{ id: string; deliverableId: string | null }>;
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const item of items) {
      expect(item.deliverableId).toBe(deliverableA);
    }
    expect(items.map((i) => i.id)).toContain(aSecondId);
  });

  it('GET /comments (no filter) → returns plan-level + all per-deliverable rows', async () => {
    const res = await GET(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, { userName: owner }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = body.data as Array<{ deliverableId: string | null }>;
    // Mixed surface: at least one row from A, one from B, and one
    // plan-level row from the earlier cases.
    expect(items.some((i) => i.deliverableId === deliverableA)).toBe(true);
    expect(items.some((i) => i.deliverableId === deliverableB)).toBe(true);
    expect(items.some((i) => i.deliverableId === null)).toBe(true);
  });
});

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

  // ---- #1261: reply must share its parent's deliverable anchor -----------
  //
  // The per-field checks above (parent in same plan, deliverable in same
  // plan) are individually correct but together leave a gap: a reply could
  // be threaded under a plan-level parent while still claiming a
  // deliverable anchor (or vice versa), so the timeline UI would lose
  // half of the thread depending on which view it renders. These cases
  // pin the cross-field invariant: parent.deliverableId === reply.deliverableId.

  it('#1261: reply to plan-level parent with a deliverableId → 400', async () => {
    const parentRes = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'plan-level parent for #1261' },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const parentId = (await parentRes.json()).data.id;

    const replyRes = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'reply anchored to A', parentId, deliverableId: deliverableA },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(replyRes.status).toBe(400);
    const body = await replyRes.json();
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toMatch(/same deliverable anchor/);

    const stray = await testPrisma.planComment.findFirst({
      where: { parentId, deliverableId: deliverableA },
    });
    expect(stray).toBeNull();
  });

  it('#1261: reply to deliverable-A parent without a deliverableId → 400', async () => {
    const parentRes = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'parent on A', deliverableId: deliverableA },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const parentId = (await parentRes.json()).data.id;

    const replyRes = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'reply with no anchor', parentId },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(replyRes.status).toBe(400);
    const body = await replyRes.json();
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toMatch(/same deliverable anchor/);
  });

  it('#1261: reply to deliverable-A parent with deliverableId=B → 400', async () => {
    const parentRes = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'parent on A (cross-deliv test)', deliverableId: deliverableA },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const parentId = (await parentRes.json()).data.id;

    const replyRes = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'reply on B', parentId, deliverableId: deliverableB },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(replyRes.status).toBe(400);
    const body = await replyRes.json();
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toMatch(/same deliverable anchor/);
  });

  it('#1261: reply that matches its parent anchor → 201 (happy paths)', async () => {
    // Plan-level parent, plan-level reply.
    const planParentRes = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'plan-level parent (happy)' },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const planParentId = (await planParentRes.json()).data.id;
    const planReplyRes = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'plan-level reply', parentId: planParentId },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(planReplyRes.status).toBe(201);

    // Deliverable-A parent, deliverable-A reply.
    const aParentRes = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'parent on A (happy)', deliverableId: deliverableA },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const aParentId = (await aParentRes.json()).data.id;
    const aReplyRes = await POST(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, {
        method: 'POST',
        userName: owner,
        body: { content: 'reply on A', parentId: aParentId, deliverableId: deliverableA },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(aReplyRes.status).toBe(201);
    const aReplyBody = await aReplyRes.json();
    expect(aReplyBody.data.parentId).toBe(aParentId);
    expect(aReplyBody.data.deliverableId).toBe(deliverableA);
  });

  it('plan include with `where: { deliverableId: null }` excludes per-deliverable rows — Issue #1256', async () => {
    // Mirrors the SSR query in `packages/api/src/app/projects/[id]/plans/page.tsx`,
    // which includes `comments` for the legacy plan-level sidebar. The
    // include MUST filter `deliverableId IS NULL` so per-deliverable
    // comments never leak into the sidebar render.
    const planWithComments = await testPrisma.plan.findUnique({
      where: { id: planId },
      include: {
        comments: { where: { deliverableId: null }, orderBy: { createdAt: 'asc' } },
      },
    });
    expect(planWithComments).not.toBeNull();
    const sidebarComments = planWithComments!.comments;
    expect(sidebarComments.length).toBeGreaterThanOrEqual(1);
    for (const c of sidebarComments) {
      expect(c.deliverableId).toBeNull();
    }
  });

  it('GET /comments (no filter) → only plan-level rows (deliverableId IS NULL) — Issue #1256', async () => {
    // Regression for #1256: the legacy plan-level Comments sidebar calls
    // GET /comments without a `deliverableId` query. Per-deliverable rows
    // must NOT bleed into that response — they have their own focused
    // thread on the deliverable timeline page.
    const res = await GET(
      makeReq(`/api/projects/${projectId}/plans/${planId}/comments`, { userName: owner }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = body.data as Array<{ deliverableId: string | null }>;
    // The earlier cases wrote: 2 comments on A, 1 on B, 1 plan-level.
    // The default (no-filter) listing must include the plan-level row…
    expect(items.some((i) => i.deliverableId === null)).toBe(true);
    // …and must NOT include any deliverable-anchored row.
    expect(items.every((i) => i.deliverableId === null)).toBe(true);
    expect(items.some((i) => i.deliverableId === deliverableA)).toBe(false);
    expect(items.some((i) => i.deliverableId === deliverableB)).toBe(false);
  });
});

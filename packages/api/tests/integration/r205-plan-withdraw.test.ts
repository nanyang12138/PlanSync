// R-205: plansync_plan_withdraw escape hatch.
//
// Without this route a `proposed` plan whose reviewer set turned out wrong was
// stuck — propose only accepted drafts, and there was no MCP-visible way to
// add reviewers, change them, or roll back. Withdraw returns the plan to
// `draft` and clears any pending PlanReview rows so the owner can edit and
// re-propose. See packages/api/src/app/api/projects/[projectId]/plans/[planId]/withdraw/route.ts
// for the full rationale.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as proposePost } from '@/app/api/projects/[projectId]/plans/[planId]/propose/route';
import { POST as withdrawPost } from '@/app/api/projects/[projectId]/plans/[planId]/withdraw/route';
import { makeReq, createTestProject, cleanupProject, testPrisma } from '../helpers/request';

async function createDraftPlan(projectId: string, owner: string, title: string) {
  const latest = await testPrisma.plan.findFirst({
    where: { projectId },
    orderBy: { version: 'desc' },
  });
  return (
    await testPrisma.plan.create({
      data: {
        projectId,
        title,
        goal: 'g',
        scope: 's',
        version: (latest?.version ?? 0) + 1,
        status: 'draft',
        createdBy: owner,
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
      },
    })
  ).id;
}

describe('R-205: plansync_plan_withdraw route', () => {
  const owner = 'r205-withdraw-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('returns a proposed plan to draft and deletes pending PlanReview rows', async () => {
    const planId = await createDraftPlan(projectId, owner, 'R205 Withdraw-Happy');

    await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/propose`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId } },
    );

    const before = await testPrisma.planReview.count({ where: { planId } });
    expect(before).toBe(1);

    const wRes = await withdrawPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/withdraw`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId } },
    );
    expect(wRes.status).toBe(200);
    const wBody = await wRes.json();
    expect(wBody.data.status).toBe('draft');

    const after = await testPrisma.planReview.count({ where: { planId } });
    expect(after).toBe(0);

    const activity = await testPrisma.activity.findFirst({
      where: { projectId, type: 'plan_withdrawn' },
      orderBy: { createdAt: 'desc' },
    });
    expect(activity).not.toBeNull();
  });

  it('lets the withdrawn draft be re-proposed with a different reviewer set', async () => {
    const planId = await createDraftPlan(projectId, owner, 'R205 Withdraw-Cycle');
    const newReviewer = 'r205-new-reviewer';

    await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/propose`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId } },
    );
    await withdrawPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/withdraw`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId } },
    );
    const reproposeRes = await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/propose`, {
        method: 'POST',
        userName: owner,
        body: { reviewers: [newReviewer] },
      }),
      { params: { projectId, planId } },
    );
    expect(reproposeRes.status).toBe(200);

    const reviews = await testPrisma.planReview.findMany({ where: { planId } });
    expect(reviews).toHaveLength(1);
    expect(reviews[0].reviewerName).toBe(newReviewer);
  });

  it('rejects withdraw when the plan is not in proposed status', async () => {
    const planId = await createDraftPlan(projectId, owner, 'R205 Withdraw-Bad-State');

    const wRes = await withdrawPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/withdraw`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId } },
    );
    expect(wRes.status).toBe(409);
    const body = await wRes.json();
    expect(body.error.code).toBe('STATE_CONFLICT');
    expect(body.error.message).toMatch(/Only proposed/);
  });

  it('rejects withdraw from a non-owner', async () => {
    // A non-member cannot withdraw — requireProjectRole(owner) refuses them.
    const planId = await createDraftPlan(projectId, owner, 'R205 Withdraw-Forbidden');
    await testPrisma.plan.update({ where: { id: planId }, data: { status: 'proposed' } });

    const wRes = await withdrawPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/withdraw`, {
        method: 'POST',
        userName: 'not-the-owner',
        body: {},
      }),
      { params: { projectId, planId } },
    );
    // 403 forbidden (or 401 if header auth is missing). Either is fine here —
    // the contract is "not 200, plan untouched".
    expect([401, 403]).toContain(wRes.status);
    const after = await testPrisma.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(after.status).toBe('proposed');
  });
});

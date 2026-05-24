// R-055: a 'proposed' plan with zero reviewers must not slip through the
// review gate. Before R-205, propose-with-empty-body left the plan with zero
// PlanReview rows and the activate route rejected the activation unless
// ?force=true was supplied. R-205 changed propose to auto-add the owner as
// a reviewer when no reviewer set is provided, so the zero-reviewer case is
// now reachable only for legacy plans (or via direct DB insert in this test
// suite). The force override still exists for those legacy rows.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { POST as proposePost } from '@/app/api/projects/[projectId]/plans/[planId]/propose/route';
import { POST as reviewPost } from '@/app/api/projects/[projectId]/plans/[planId]/reviews/[reviewId]/route';
import {
  makeReq,
  createTestProject,
  addMember,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

async function createDraftPlan(projectId: string, owner: string, title: string) {
  const latest = await testPrisma.plan.findFirst({
    where: { projectId },
    orderBy: { version: 'desc' },
  });
  const plan = await testPrisma.plan.create({
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
  });
  return plan.id;
}

/**
 * Build a "legacy" proposed plan that has zero PlanReview rows. New plans
 * cannot reach this state through the propose route after R-205, but existing
 * rows in production may still look like this. The force override path must
 * keep working for them.
 */
async function createLegacyZeroReviewerProposedPlan(
  projectId: string,
  owner: string,
  title: string,
) {
  const planId = await createDraftPlan(projectId, owner, title);
  await testPrisma.plan.update({
    where: { id: planId },
    data: { status: 'proposed' },
  });
  return planId;
}

describe('R-055: activate route requires non-zero reviewers OR explicit owner force', () => {
  const owner = 'r055-owner';
  const reviewer = 'r055-reviewer';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, reviewer);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('rejects activating a legacy zero-reviewer proposed plan without force', async () => {
    const planId = await createLegacyZeroReviewerProposedPlan(
      projectId,
      owner,
      'R055 Legacy-No-Reviewers',
    );

    const actRes = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId } },
    );
    expect(actRes.status).toBe(409);
    const actBody = await actRes.json();
    expect(actBody.error.code).toBe('STATE_CONFLICT');
    // R-205: error message must mention BOTH the MCP tool and the HTTP query
    // parameter so AI agents do not invent a non-existent CLI subcommand.
    expect(actBody.error.message).toMatch(/plansync_plan_activate/);
    expect(actBody.error.message).toMatch(/force=true/);

    const after = await testPrisma.plan.findUnique({ where: { id: planId } });
    expect(after?.status).toBe('proposed');
  });

  it('allows owner to override a legacy zero-reviewer proposed plan with ?force=true', async () => {
    const planId = await createLegacyZeroReviewerProposedPlan(
      projectId,
      owner,
      'R055 Legacy-Force-Override',
    );

    const actRes = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
        searchParams: { force: 'true' },
      }),
      { params: { projectId, planId } },
    );
    expect(actRes.status).toBe(200);
    const actBody = await actRes.json();
    expect(actBody.data.status).toBe('active');
  });

  it('still rejects when reviewers exist and not all approved (regression)', async () => {
    const planId = await createDraftPlan(projectId, owner, 'R055 Pending-Review');

    const propRes = await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/propose`, {
        method: 'POST',
        userName: owner,
        body: { reviewers: [reviewer] },
      }),
      { params: { projectId, planId } },
    );
    expect(propRes.status).toBe(200);

    const actRes = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId } },
    );
    expect(actRes.status).toBe(409);
    const actBody = await actRes.json();
    expect(actBody.error.code).toBe('STATE_CONFLICT');
    expect(actBody.error.message).toMatch(/approved/i);

    // ?force=true must NOT bypass review when reviewers exist; the force
    // override is only for the zero-reviewer case.
    const forcedRes = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
        searchParams: { force: 'true' },
      }),
      { params: { projectId, planId } },
    );
    expect(forcedRes.status).toBe(409);
  });

  it('activates normally once all reviewers approve (regression)', async () => {
    const planId = await createDraftPlan(projectId, owner, 'R055 Approved-Plan');

    await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/propose`, {
        method: 'POST',
        userName: owner,
        body: { reviewers: [reviewer] },
      }),
      { params: { projectId, planId } },
    );

    const reviews = await testPrisma.planReview.findMany({ where: { planId } });
    expect(reviews.length).toBe(1);
    const reviewId = reviews[0].id;

    const approveRes = await reviewPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/reviews/${reviewId}`, {
        method: 'POST',
        userName: reviewer,
        body: {},
        searchParams: { action: 'approve' },
      }),
      { params: { projectId, planId, reviewId } },
    );
    expect(approveRes.status).toBe(200);

    const actRes = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId } },
    );
    expect(actRes.status).toBe(200);
    const actBody = await actRes.json();
    expect(actBody.data.status).toBe('active');
  });
});

// R-055: a 'proposed' plan with zero reviewers must not slip through the
// review gate. Previously the activate route only checked `reviews.every(...
// approved)` when `reviews.length > 0`, so propose-with-empty-reviewers
// followed immediately by activate bypassed review entirely. The route now
// requires an explicit `?force=true` owner override for the no-reviewer case
// and continues to require all-approved when reviewers exist.
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

  it('rejects activating a proposed plan that has zero reviewers (no force)', async () => {
    const planId = await createDraftPlan(projectId, owner, 'R055 No-Reviewers');

    // Propose with no reviewers (body omitted, plan.requiredReviewers is [])
    const propRes = await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/propose`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId } },
    );
    expect(propRes.status).toBe(200);
    const propBody = await propRes.json();
    expect(propBody.data.status).toBe('proposed');

    // Sanity: no PlanReview rows were created.
    const reviews = await testPrisma.planReview.findMany({ where: { planId } });
    expect(reviews.length).toBe(0);

    // Activate without force → must 409 STATE_CONFLICT
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
    expect(actBody.error.message).toMatch(/force=true/);

    // Plan must remain proposed (not activated)
    const after = await testPrisma.plan.findUnique({ where: { id: planId } });
    expect(after?.status).toBe('proposed');
  });

  it('allows owner to override with ?force=true on a zero-reviewer proposed plan', async () => {
    const planId = await createDraftPlan(projectId, owner, 'R055 Force-Override');

    await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/propose`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId } },
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

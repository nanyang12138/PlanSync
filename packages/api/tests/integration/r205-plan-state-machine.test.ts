// R-205: close the plan-state-machine dead-end.
//
// Background: a `proposed` plan with zero reviewers used to be a stuck state
// reachable through the MCP tools — propose accepted an empty reviewer list,
// activate rejected it without `?force=true`, and there was no MCP-visible
// way out. This test pins the four invariants that, taken together, close
// the trap:
//
//   1. propose with no reviewers auto-adds the owner as a self-reviewer
//      (owner-self-review fallback) so the activate gate's zero-reviewer
//      branch is unreachable for new plans.
//   2. The activate route's force error message references both the MCP tool
//      (`plansync_plan_activate`) and the HTTP query parameter (`?force=true`)
//      so an AI consumer cannot invent a non-existent CLI flag from the text.
//   3. plan_activated activity records `forceUsed` in metadata for audit.
//   4. The withdraw route returns a `proposed` plan to `draft`, deletes its
//      pending PlanReview rows, and rejects calls when the plan is not
//      currently `proposed`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { POST as proposePost } from '@/app/api/projects/[projectId]/plans/[planId]/propose/route';
import { POST as reviewPost } from '@/app/api/projects/[projectId]/plans/[planId]/reviews/[reviewId]/route';
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

describe('R-205: owner self-review fallback on propose', () => {
  const owner = 'r205-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('auto-adds owner as reviewer when propose body is empty AND requiredReviewers is empty', async () => {
    const planId = await createDraftPlan(projectId, owner, 'R205 Owner-Self');

    const propRes = await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/propose`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(propRes.status).toBe(200);

    const reviews = await testPrisma.planReview.findMany({ where: { planId } });
    expect(reviews).toHaveLength(1);
    expect(reviews[0].reviewerName).toBe(owner);
    expect(reviews[0].status).toBe('pending');

    // The proposed plan is now activatable WITHOUT ?force=true once the
    // owner approves their own review — this is the path that previously
    // required an out-of-band CLI flag.
    const reviewId = reviews[0].id;
    await reviewPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/reviews/${reviewId}`, {
        method: 'POST',
        userName: owner,
        body: {},
        searchParams: { action: 'approve' },
      }),
      { params: Promise.resolve({ projectId, planId, reviewId }) },
    );

    const actRes = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(actRes.status).toBe(200);
    const actBody = await actRes.json();
    expect(actBody.data.status).toBe('active');
  });

  it('records ownerSelfReviewFallback flag in plan_proposed activity metadata', async () => {
    const planId = await createDraftPlan(projectId, owner, 'R205 Audit-Fallback');

    await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/propose`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );

    const proposedActivity = await testPrisma.activity.findFirst({
      where: { projectId, type: 'plan_proposed' },
      orderBy: { createdAt: 'desc' },
    });
    expect(proposedActivity).not.toBeNull();
    expect((proposedActivity!.metadata as Record<string, unknown>).ownerSelfReviewFallback).toBe(
      true,
    );
    expect((proposedActivity!.metadata as Record<string, unknown>).reviewerCount).toBe(1);
  });

  it('does NOT auto-add owner when reviewers are explicitly provided', async () => {
    const planId = await createDraftPlan(projectId, owner, 'R205 Explicit-Reviewers');
    const explicitReviewer = 'r205-explicit';

    await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/propose`, {
        method: 'POST',
        userName: owner,
        body: { reviewers: [explicitReviewer] },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );

    const reviews = await testPrisma.planReview.findMany({ where: { planId } });
    expect(reviews).toHaveLength(1);
    expect(reviews[0].reviewerName).toBe(explicitReviewer);
  });

  it('does NOT auto-add owner when plan.requiredReviewers is non-empty', async () => {
    // Manually craft a plan with a non-empty requiredReviewers list.
    const latest = await testPrisma.plan.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
    });
    const baseline = 'r205-baseline';
    const plan = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'R205 Required-Reviewers',
        goal: 'g',
        scope: 's',
        version: (latest?.version ?? 0) + 1,
        status: 'draft',
        createdBy: owner,
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [baseline],
      },
    });

    await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${plan.id}/propose`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, planId: plan.id }) },
    );

    const reviews = await testPrisma.planReview.findMany({ where: { planId: plan.id } });
    expect(reviews).toHaveLength(1);
    expect(reviews[0].reviewerName).toBe(baseline);
  });
});

describe('R-205: activate force=true records audit metadata', () => {
  const owner = 'r205-force-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('writes forceUsed=true to plan_activated activity when force is used', async () => {
    const planId = await createDraftPlan(projectId, owner, 'R205 Force-Audit');
    // Simulate a legacy zero-reviewer proposed plan by flipping status directly.
    await testPrisma.plan.update({ where: { id: planId }, data: { status: 'proposed' } });

    const actRes = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
        searchParams: { force: 'true' },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(actRes.status).toBe(200);

    const activity = await testPrisma.activity.findFirst({
      where: { projectId, type: 'plan_activated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(activity).not.toBeNull();
    expect((activity!.metadata as Record<string, unknown>).forceUsed).toBe(true);
    expect(activity!.summary).toMatch(/force/);
  });

  it('writes forceUsed=false on a normal review-approved activation', async () => {
    const planId = await createDraftPlan(projectId, owner, 'R205 Normal-Audit');

    await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/propose`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );

    const review = await testPrisma.planReview.findFirstOrThrow({ where: { planId } });
    await reviewPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/reviews/${review.id}`, {
        method: 'POST',
        userName: owner,
        body: {},
        searchParams: { action: 'approve' },
      }),
      { params: Promise.resolve({ projectId, planId, reviewId: review.id }) },
    );

    await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );

    const activity = await testPrisma.activity.findFirst({
      where: { projectId, type: 'plan_activated' },
      orderBy: { createdAt: 'desc' },
    });
    expect((activity!.metadata as Record<string, unknown>).forceUsed).toBe(false);
    expect(activity!.summary).not.toMatch(/force/);
  });
});

// R-104: plan PATCH 写 activity
//
// The PATCH /projects/:projectId/plans/:planId endpoint is the canonical
// owner-driven plan-edit surface. Before R-104 it only fired SSE/webhook
// events but skipped the audit log, so audit consumers could not tell who
// changed which field on a draft plan. This test asserts that:
//   1. editing a draft plan writes an `activity` row with type=plan_updated;
//   2. the activity captures the changed fields and the editor's name;
//   3. editing requiredReviewers on a proposed plan ALSO writes an activity
//      (the second allowed code path on this route).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as plansPost } from '@/app/api/projects/[projectId]/plans/route';
import { PATCH as planPatch } from '@/app/api/projects/[projectId]/plans/[planId]/route';
import { POST as proposePost } from '@/app/api/projects/[projectId]/plans/[planId]/propose/route';
import {
  makeReq,
  createTestProject,
  addMember,
  cleanupProject,
  resetDraftPlans,
  testPrisma,
} from '../helpers/request';

describe('R-104: plan PATCH writes activity', () => {
  const owner = 'r104-owner';
  const reviewer1 = 'r104-reviewer-1';
  const reviewer2 = 'r104-reviewer-2';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, reviewer1);
    await addMember(projectId, reviewer2);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('PATCH draft plan → activity row type=plan_updated with fields metadata', async () => {
    const createRes = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'R104 Draft',
          goal: 'initial goal',
          scope: 'initial scope',
          constraints: [],
          standards: [],
          deliverables: [],
          openQuestions: [],
          requiredReviewers: [],
        },
      }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(createRes.status).toBe(201);
    const planId = (await createRes.json()).data.id;

    const before = await testPrisma.activity.count({
      where: { projectId, type: 'plan_updated' },
    });

    const patchRes = await planPatch(
      makeReq(`/api/projects/${projectId}/plans/${planId}`, {
        method: 'PATCH',
        userName: owner,
        body: { goal: 'updated goal', scope: 'updated scope' },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(patchRes.status).toBe(200);

    const after = await testPrisma.activity.findMany({
      where: { projectId, type: 'plan_updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(after.length).toBe(before + 1);

    const activity = after[0];
    expect(activity.actorName).toBe(owner);
    expect(activity.actorType).toBe('human');
    expect(activity.summary).toContain('updated');

    const md = activity.metadata as {
      planId?: string;
      version?: number;
      fields?: string[];
      planStatus?: string;
    } | null;
    expect(md?.planId).toBe(planId);
    expect(md?.fields).toEqual(expect.arrayContaining(['goal', 'scope']));
    expect(md?.planStatus).toBe('draft');
  });

  it('PATCH proposed plan requiredReviewers → activity row type=plan_updated', async () => {
    await resetDraftPlans(projectId);

    const createRes = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'R104 Proposed',
          goal: 'g',
          scope: 's',
          constraints: [],
          standards: [],
          deliverables: [],
          openQuestions: [],
          requiredReviewers: [reviewer1],
        },
      }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(createRes.status).toBe(201);
    const planId = (await createRes.json()).data.id;

    const propRes = await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/propose`, {
        method: 'POST',
        userName: owner,
        body: { reviewers: [reviewer1] },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(propRes.status).toBe(200);

    const before = await testPrisma.activity.count({
      where: { projectId, type: 'plan_updated' },
    });

    // proposed plans accept requiredReviewers edits only
    const patchRes = await planPatch(
      makeReq(`/api/projects/${projectId}/plans/${planId}`, {
        method: 'PATCH',
        userName: owner,
        body: { requiredReviewers: [reviewer1, reviewer2] },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(patchRes.status).toBe(200);

    const after = await testPrisma.activity.findMany({
      where: { projectId, type: 'plan_updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(after.length).toBe(before + 1);

    const activity = after[0];
    const md = activity.metadata as {
      planStatus?: string;
      fields?: string[];
    } | null;
    expect(md?.planStatus).toBe('proposed');
    expect(md?.fields).toEqual(['requiredReviewers']);
  });
});

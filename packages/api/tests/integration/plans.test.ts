// C module: Plan lifecycle state machine
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as plansPost, GET as plansGet } from '@/app/api/projects/[projectId]/plans/route';
import {
  GET as planGet,
  PATCH as planPatch,
} from '@/app/api/projects/[projectId]/plans/[planId]/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { POST as proposePost } from '@/app/api/projects/[projectId]/plans/[planId]/propose/route';
import { POST as reactivatePost } from '@/app/api/projects/[projectId]/plans/[planId]/reactivate/route';
import { GET as activeGet } from '@/app/api/projects/[projectId]/plans/active/route';
import { POST as reviewPost } from '@/app/api/projects/[projectId]/plans/[planId]/reviews/[reviewId]/route';
import {
  makeReq,
  createTestProject,
  addMember,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('C: Plan Lifecycle', () => {
  const owner = 'plan-owner';
  const reviewer = 'plan-reviewer';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, reviewer);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  let draftPlanId: string;
  let draftVersion: number;

  it('C1: POST /plans → 201, status=draft, version=1', async () => {
    const res = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'Plan Alpha',
          goal: 'goal',
          scope: 'scope',
          constraints: [],
          standards: [],
          deliverables: [],
          openQuestions: [],
          requiredReviewers: [],
        },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.status).toBe('draft');
    expect(body.data.version).toBeGreaterThan(0);
    draftPlanId = body.data.id;
    draftVersion = body.data.version;
  });

  it('C1边: POST /plans 缺少必填字段 → 400 VALIDATION_ERROR', async () => {
    const res = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Missing fields' }, // missing goal, scope
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('C1边: 非成员创建 plan → 403', async () => {
    const res = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: 'not-a-member',
        body: {
          title: 'P',
          goal: 'g',
          scope: 's',
          constraints: [],
          standards: [],
          deliverables: [],
          openQuestions: [],
          requiredReviewers: [],
        },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(403);
  });

  it('C2: PATCH draft plan → 200', async () => {
    const res = await planPatch(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}`, {
        method: 'PATCH',
        userName: owner,
        body: { goal: 'updated goal' },
      }),
      { params: { projectId, planId: draftPlanId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.goal).toBe('updated goal');
  });

  it('C3: activate (无 reviewers) → active', async () => {
    const res = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId: draftPlanId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('active');
  });

  it('C11: GET /plans/active → 200', async () => {
    const res = await activeGet(
      makeReq(`/api/projects/${projectId}/plans/active`, { userName: owner }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).not.toBeNull();
    expect(body.data.status).toBe('active');
  });

  it('C9: activate v2 → v1 变 superseded', async () => {
    // Create v2
    const res2 = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'Plan Beta',
          goal: 'g2',
          scope: 's2',
          constraints: [],
          standards: [],
          deliverables: [],
          openQuestions: [],
          requiredReviewers: [],
        },
      }),
      { params: { projectId } },
    );
    const planV2Id = (await res2.json()).data.id;

    await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planV2Id}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId: planV2Id } },
    );

    // v1 should now be superseded
    const v1res = await planGet(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}`, { userName: owner }),
      { params: { projectId, planId: draftPlanId } },
    );
    const v1 = await v1res.json();
    expect(v1.data.status).toBe('superseded');

    // C10: reactivate superseded → active
    const reactivateRes = await reactivatePost(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}/reactivate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId: draftPlanId } },
    );
    expect(reactivateRes.status).toBe(200);
    const reactivated = await reactivateRes.json();
    expect(reactivated.data.status).toBe('active');
  });

  it('C15: PATCH proposed plan → 400', async () => {
    // Create and propose a plan
    const createRes = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'Plan Gamma',
          goal: 'g3',
          scope: 's3',
          constraints: [],
          standards: [],
          deliverables: [],
          openQuestions: [],
          requiredReviewers: [],
        },
      }),
      { params: { projectId } },
    );
    const proposedPlanId = (await createRes.json()).data.id;

    await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${proposedPlanId}/propose`, {
        method: 'POST',
        userName: owner,
        body: { reviewers: [reviewer] },
      }),
      { params: { projectId, planId: proposedPlanId } },
    );

    const patchRes = await planPatch(
      makeReq(`/api/projects/${projectId}/plans/${proposedPlanId}`, {
        method: 'PATCH',
        userName: owner,
        body: { goal: 'should fail' },
      }),
      { params: { projectId, planId: proposedPlanId } },
    );
    expect(patchRes.status).toBe(409);
    const body = await patchRes.json();
    expect(body.error.code).toBe('STATE_CONFLICT');
  });

  it('C4/C5: propose → approve → activate', async () => {
    // Create fresh plan
    const createRes = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'Plan Delta',
          goal: 'g4',
          scope: 's4',
          constraints: [],
          standards: [],
          deliverables: [],
          openQuestions: [],
          requiredReviewers: [],
        },
      }),
      { params: { projectId } },
    );
    const newPlanId = (await createRes.json()).data.id;

    // C4: propose
    const propRes = await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${newPlanId}/propose`, {
        method: 'POST',
        userName: owner,
        body: { reviewers: [reviewer] },
      }),
      { params: { projectId, planId: newPlanId } },
    );
    expect(propRes.status).toBe(200);
    const propBody = await propRes.json();
    expect(propBody.data.status).toBe('proposed');

    // C7: try activate with pending reviews → 400
    const earlyActivate = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${newPlanId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId: newPlanId } },
    );
    expect(earlyActivate.status).toBe(409);

    // C5: approve
    const reviews = await testPrisma.planReview.findMany({ where: { planId: newPlanId } });
    const reviewId = reviews[0].id;
    const approveRes = await reviewPost(
      makeReq(`/api/projects/${projectId}/plans/${newPlanId}/reviews/${reviewId}?action=approve`, {
        method: 'POST',
        userName: reviewer,
        body: {},
      }),
      { params: { projectId, planId: newPlanId, reviewId } },
    );
    expect(approveRes.status).toBe(200);
    const approveBody = await approveRes.json();
    expect(approveBody.data.status).toBe('approved');

    // C8: all approved → activate
    const actRes = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${newPlanId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId: newPlanId } },
    );
    expect(actRes.status).toBe(200);
    const actBody = await actRes.json();
    expect(actBody.data.status).toBe('active');
  });

  it('C6: reject review → rejected', async () => {
    const createRes = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'Plan Epsilon',
          goal: 'g5',
          scope: 's5',
          constraints: [],
          standards: [],
          deliverables: [],
          openQuestions: [],
          requiredReviewers: [],
        },
      }),
      { params: { projectId } },
    );
    const planId2 = (await createRes.json()).data.id;

    await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${planId2}/propose`, {
        method: 'POST',
        userName: owner,
        body: { reviewers: [reviewer] },
      }),
      { params: { projectId, planId: planId2 } },
    );

    const reviews = await testPrisma.planReview.findMany({ where: { planId: planId2 } });
    const reviewId = reviews[0].id;
    const rejectRes = await reviewPost(
      makeReq(`/api/projects/${projectId}/plans/${planId2}/reviews/${reviewId}?action=reject`, {
        method: 'POST',
        userName: reviewer,
        body: {},
      }),
      { params: { projectId, planId: planId2, reviewId } },
    );
    expect(rejectRes.status).toBe(200);
    expect((await rejectRes.json()).data.status).toBe('rejected');
  });

  it('C12: 连续创建 3 个 plan → version 递增', async () => {
    const versions: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await plansPost(
        makeReq(`/api/projects/${projectId}/plans`, {
          method: 'POST',
          userName: owner,
          body: {
            title: `Version Plan ${i}`,
            goal: 'g',
            scope: 's',
            constraints: [],
            standards: [],
            deliverables: [],
            openQuestions: [],
            requiredReviewers: [],
          },
        }),
        { params: { projectId } },
      );
      const body = await res.json();
      versions.push(body.data.version);
    }
    expect(versions[1]).toBeGreaterThan(versions[0]);
    expect(versions[2]).toBeGreaterThan(versions[1]);
  });
});

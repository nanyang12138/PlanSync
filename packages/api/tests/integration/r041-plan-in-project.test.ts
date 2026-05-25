// R-041: All `/plans/[planId]/...` routes must verify that the plan belongs
// to the project in the URL. Without the check, a project A member could read
// or write plan sub-resources of project B simply by knowing the planId.
//
// "Plan does not exist" and "plan belongs to a different project" both collapse
// into the same NOT_FOUND response so callers cannot probe for plan existence
// across projects.
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';

vi.mock('@/lib/email', () => ({
  sendMail: vi.fn(),
  userEmail: (name: string) => `${name}@amd.com`,
}));

import {
  GET as planGet,
  PATCH as planPatch,
  DELETE as planDelete,
} from '@/app/api/projects/[projectId]/plans/[planId]/route';
import { POST as appendPost } from '@/app/api/projects/[projectId]/plans/[planId]/append/route';
import { POST as proposePost } from '@/app/api/projects/[projectId]/plans/[planId]/propose/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { POST as reactivatePost } from '@/app/api/projects/[projectId]/plans/[planId]/reactivate/route';
import {
  GET as commentsGet,
  POST as commentsPost,
} from '@/app/api/projects/[projectId]/plans/[planId]/comments/route';
import {
  GET as suggestionsGet,
  POST as suggestionsPost,
} from '@/app/api/projects/[projectId]/plans/[planId]/suggestions/route';
import {
  GET as reviewsGet,
  POST as reviewsPost,
} from '@/app/api/projects/[projectId]/plans/[planId]/reviews/route';
import { GET as diffGet } from '@/app/api/projects/[projectId]/plans/[planId]/diff/route';
import {
  makeReq,
  createTestProject,
  addMember,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('R-041: /plans/[planId]/* routes verify plan ∈ project', () => {
  const ownerA = 'r041-owner-a';
  const ownerB = 'r041-owner-b';
  const memberA = 'r041-member-a';
  let projectAId: string;
  let projectBId: string;
  let planBDraftId: string;
  let planBProposedId: string;
  let planBActiveId: string;
  let planBSupersededId: string;

  beforeAll(async () => {
    ({ projectId: projectAId } = await createTestProject(ownerA));
    ({ projectId: projectBId } = await createTestProject(ownerB));
    // memberA exists in project A but NOT in project B.
    await addMember(projectAId, memberA);

    const draft = await testPrisma.plan.create({
      data: {
        projectId: projectBId,
        title: 'Project B Draft',
        goal: 'g',
        scope: 's',
        version: 10,
        status: 'draft',
        createdBy: ownerB,
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
      },
    });
    planBDraftId = draft.id;

    const proposed = await testPrisma.plan.create({
      data: {
        projectId: projectBId,
        title: 'Project B Proposed',
        goal: 'g',
        scope: 's',
        version: 11,
        status: 'proposed',
        createdBy: ownerB,
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
      },
    });
    planBProposedId = proposed.id;

    const active = await testPrisma.plan.create({
      data: {
        projectId: projectBId,
        title: 'Project B Active',
        goal: 'g',
        scope: 's',
        version: 12,
        status: 'active',
        createdBy: ownerB,
        activatedAt: new Date(),
        activatedBy: ownerB,
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
      },
    });
    planBActiveId = active.id;

    const superseded = await testPrisma.plan.create({
      data: {
        projectId: projectBId,
        title: 'Project B Superseded',
        goal: 'g',
        scope: 's',
        version: 9,
        status: 'superseded',
        createdBy: ownerB,
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
      },
    });
    planBSupersededId = superseded.id;
  });

  afterAll(async () => {
    await cleanupProject(projectAId);
    await cleanupProject(projectBId);
  });

  // The owner of project A (a legitimate member of A but NOT B) tries to access
  // project B's plan via the /projects/A/plans/B URL. The expectation is that
  // EVERY nested route returns 404, even though project A's role check would
  // succeed against project A's membership table — without R-041 the route
  // would then happily operate on plan-of-B.
  it('GET /plans/:planId — cross-project access → 404 NOT_FOUND', async () => {
    const res = await planGet(
      makeReq(`/api/projects/${projectAId}/plans/${planBDraftId}`, { userName: ownerA }),
      { params: Promise.resolve({ projectId: projectAId, planId: planBDraftId }) },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('PATCH /plans/:planId — cross-project access → 404', async () => {
    const res = await planPatch(
      makeReq(`/api/projects/${projectAId}/plans/${planBDraftId}`, {
        method: 'PATCH',
        userName: ownerA,
        body: { goal: 'hacked' },
      }),
      { params: Promise.resolve({ projectId: projectAId, planId: planBDraftId }) },
    );
    expect(res.status).toBe(404);

    // Confirm the target plan in project B was NOT modified.
    const after = await testPrisma.plan.findUnique({ where: { id: planBDraftId } });
    expect(after?.goal).toBe('g');
  });

  it('DELETE /plans/:planId — cross-project access → 404', async () => {
    const res = await planDelete(
      makeReq(`/api/projects/${projectAId}/plans/${planBDraftId}`, {
        method: 'DELETE',
        userName: ownerA,
      }),
      { params: Promise.resolve({ projectId: projectAId, planId: planBDraftId }) },
    );
    expect(res.status).toBe(404);

    // Plan still exists in project B.
    const after = await testPrisma.plan.findUnique({ where: { id: planBDraftId } });
    expect(after).not.toBeNull();
  });

  it('POST /plans/:planId/append — cross-project access → 404', async () => {
    const res = await appendPost(
      makeReq(`/api/projects/${projectAId}/plans/${planBDraftId}/append`, {
        method: 'POST',
        userName: ownerA,
        body: { field: 'constraints', items: ['injected via cross-project'] },
      }),
      { params: Promise.resolve({ projectId: projectAId, planId: planBDraftId }) },
    );
    expect(res.status).toBe(404);

    const after = await testPrisma.plan.findUnique({ where: { id: planBDraftId } });
    expect(after?.constraints).toEqual([]);
  });

  it('POST /plans/:planId/propose — cross-project access → 404', async () => {
    const res = await proposePost(
      makeReq(`/api/projects/${projectAId}/plans/${planBDraftId}/propose`, {
        method: 'POST',
        userName: ownerA,
        body: {},
      }),
      { params: Promise.resolve({ projectId: projectAId, planId: planBDraftId }) },
    );
    expect(res.status).toBe(404);

    const after = await testPrisma.plan.findUnique({ where: { id: planBDraftId } });
    expect(after?.status).toBe('draft');
  });

  it('POST /plans/:planId/activate — cross-project access → 404', async () => {
    const res = await activatePost(
      makeReq(`/api/projects/${projectAId}/plans/${planBDraftId}/activate`, {
        method: 'POST',
        userName: ownerA,
        body: {},
      }),
      { params: Promise.resolve({ projectId: projectAId, planId: planBDraftId }) },
    );
    expect(res.status).toBe(404);

    const after = await testPrisma.plan.findUnique({ where: { id: planBDraftId } });
    expect(after?.status).toBe('draft');
  });

  it('POST /plans/:planId/reactivate — cross-project access → 404', async () => {
    const res = await reactivatePost(
      makeReq(`/api/projects/${projectAId}/plans/${planBSupersededId}/reactivate`, {
        method: 'POST',
        userName: ownerA,
        body: {},
      }),
      { params: Promise.resolve({ projectId: projectAId, planId: planBSupersededId }) },
    );
    expect(res.status).toBe(404);

    const after = await testPrisma.plan.findUnique({ where: { id: planBSupersededId } });
    expect(after?.status).toBe('superseded');
  });

  it('GET /plans/:planId/comments — cross-project access → 404', async () => {
    const res = await commentsGet(
      makeReq(`/api/projects/${projectAId}/plans/${planBActiveId}/comments`, { userName: ownerA }),
      { params: Promise.resolve({ projectId: projectAId, planId: planBActiveId }) },
    );
    expect(res.status).toBe(404);
  });

  it('POST /plans/:planId/comments — cross-project access → 404', async () => {
    const beforeCount = await testPrisma.planComment.count({ where: { planId: planBActiveId } });
    const res = await commentsPost(
      makeReq(`/api/projects/${projectAId}/plans/${planBActiveId}/comments`, {
        method: 'POST',
        userName: ownerA,
        body: { content: 'should-not-appear' },
      }),
      { params: Promise.resolve({ projectId: projectAId, planId: planBActiveId }) },
    );
    expect(res.status).toBe(404);

    const afterCount = await testPrisma.planComment.count({ where: { planId: planBActiveId } });
    expect(afterCount).toBe(beforeCount);
  });

  it('GET /plans/:planId/suggestions — cross-project access → 404', async () => {
    const res = await suggestionsGet(
      makeReq(`/api/projects/${projectAId}/plans/${planBActiveId}/suggestions`, {
        userName: ownerA,
      }),
      { params: Promise.resolve({ projectId: projectAId, planId: planBActiveId }) },
    );
    expect(res.status).toBe(404);
  });

  it('POST /plans/:planId/suggestions — cross-project access → 404', async () => {
    const before = await testPrisma.planSuggestion.count({ where: { planId: planBActiveId } });
    const res = await suggestionsPost(
      makeReq(`/api/projects/${projectAId}/plans/${planBActiveId}/suggestions`, {
        method: 'POST',
        userName: ownerA,
        body: { field: 'goal', action: 'set', value: 'injected', reason: 'r041 cross-project' },
      }),
      { params: Promise.resolve({ projectId: projectAId, planId: planBActiveId }) },
    );
    expect(res.status).toBe(404);

    const after = await testPrisma.planSuggestion.count({ where: { planId: planBActiveId } });
    expect(after).toBe(before);
  });

  it('GET /plans/:planId/reviews — cross-project access → 404', async () => {
    const res = await reviewsGet(
      makeReq(`/api/projects/${projectAId}/plans/${planBProposedId}/reviews`, {
        userName: ownerA,
      }),
      { params: Promise.resolve({ projectId: projectAId, planId: planBProposedId }) },
    );
    expect(res.status).toBe(404);
  });

  it('POST /plans/:planId/reviews — cross-project access → 404', async () => {
    const before = await testPrisma.planReview.count({ where: { planId: planBProposedId } });
    const res = await reviewsPost(
      makeReq(`/api/projects/${projectAId}/plans/${planBProposedId}/reviews`, {
        method: 'POST',
        userName: ownerA,
        body: { reviewer: memberA },
      }),
      { params: Promise.resolve({ projectId: projectAId, planId: planBProposedId }) },
    );
    expect(res.status).toBe(404);

    const after = await testPrisma.planReview.count({ where: { planId: planBProposedId } });
    expect(after).toBe(before);
  });

  it('GET /plans/:planId/diff — cross-project access → 404', async () => {
    const res = await diffGet(
      makeReq(`/api/projects/${projectAId}/plans/${planBActiveId}/diff`, { userName: ownerA }),
      { params: Promise.resolve({ projectId: projectAId, planId: planBActiveId }) },
    );
    expect(res.status).toBe(404);
  });

  it('GET /plans/:planId/diff — `compareWith` from another project also rejected → 404', async () => {
    // Create a legitimate plan in project A so the URL itself is valid;
    // attacker tries to diff against a plan in project B via ?compareWith.
    const planA = await testPrisma.plan.create({
      data: {
        projectId: projectAId,
        title: 'Project A plan v1',
        goal: 'g',
        scope: 's',
        version: 1,
        status: 'active',
        createdBy: ownerA,
        activatedAt: new Date(),
        activatedBy: ownerA,
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
      },
    });

    const res = await diffGet(
      makeReq(`/api/projects/${projectAId}/plans/${planA.id}/diff`, {
        userName: ownerA,
        searchParams: { compareWith: planBActiveId },
      }),
      { params: Promise.resolve({ projectId: projectAId, planId: planA.id }) },
    );
    expect(res.status).toBe(404);
  });

  it('legitimate GET /plans/:planId in the correct project still succeeds', async () => {
    const res = await planGet(
      makeReq(`/api/projects/${projectBId}/plans/${planBDraftId}`, { userName: ownerB }),
      { params: Promise.resolve({ projectId: projectBId, planId: planBDraftId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(planBDraftId);
    expect(body.data.projectId).toBe(projectBId);
  });
});

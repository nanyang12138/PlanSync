// R-036: API enforces "no duplicate draft/proposed plan" guard server-side
// so callers using curl or any HTTP client cannot bypass the MCP-only check.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as plansPost } from '@/app/api/projects/[projectId]/plans/route';
import { POST as proposePost } from '@/app/api/projects/[projectId]/plans/[planId]/propose/route';
import { makeReq, createTestProject, addMember, cleanupProject } from '../helpers/request';

describe('R-036: API rejects creating a second draft/proposed plan', () => {
  const owner = 'r036-owner';
  const reviewer = 'r036-reviewer';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, reviewer);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
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

  it('rejects a second plan create while a draft already exists → 409 STATE_CONFLICT', async () => {
    const first = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: planBody('R036 Draft One'),
      }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.data.status).toBe('draft');

    const second = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: planBody('R036 Draft Two'),
      }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(second.status).toBe(409);
    const errBody = await second.json();
    expect(errBody.error.code).toBe('STATE_CONFLICT');
    expect(errBody.error.details?.blockingStatus).toBe('draft');
    expect(errBody.error.details?.blockingPlanId).toBe(firstBody.data.id);
  });

  it('rejects a new plan create while a proposed plan is awaiting review → 409', async () => {
    const isolated = await createTestProject('r036-owner-2');
    const isolatedProjectId = isolated.projectId;
    await addMember(isolatedProjectId, 'r036-reviewer-2');

    try {
      const draft = await plansPost(
        makeReq(`/api/projects/${isolatedProjectId}/plans`, {
          method: 'POST',
          userName: 'r036-owner-2',
          body: planBody('R036 Proposed'),
        }),
        { params: Promise.resolve({ projectId: isolatedProjectId }) },
      );
      expect(draft.status).toBe(201);
      const draftId = (await draft.json()).data.id;

      const propRes = await proposePost(
        makeReq(`/api/projects/${isolatedProjectId}/plans/${draftId}/propose`, {
          method: 'POST',
          userName: 'r036-owner-2',
          body: { reviewers: ['r036-reviewer-2'] },
        }),
        { params: Promise.resolve({ projectId: isolatedProjectId, planId: draftId }) },
      );
      expect(propRes.status).toBe(200);
      expect((await propRes.json()).data.status).toBe('proposed');

      const blocked = await plansPost(
        makeReq(`/api/projects/${isolatedProjectId}/plans`, {
          method: 'POST',
          userName: 'r036-owner-2',
          body: planBody('R036 Should Be Blocked'),
        }),
        { params: Promise.resolve({ projectId: isolatedProjectId }) },
      );
      expect(blocked.status).toBe(409);
      const blockedBody = await blocked.json();
      expect(blockedBody.error.code).toBe('STATE_CONFLICT');
      expect(blockedBody.error.details?.blockingStatus).toBe('proposed');
    } finally {
      await cleanupProject(isolatedProjectId);
    }
  });
});

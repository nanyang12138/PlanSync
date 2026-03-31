// D module: Suggestion system
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  POST as suggestPost,
  GET as suggestGet,
} from '@/app/api/projects/[projectId]/plans/[planId]/suggestions/route';
import { POST as resolvePost } from '@/app/api/projects/[projectId]/plans/[planId]/suggestions/[suggestionId]/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('D: Suggestion System', () => {
  const owner = 'sug-owner';
  let projectId: string;
  let planId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    // Create draft plan for suggestions
    const res = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'Suggestion Test Plan',
        goal: 'original goal',
        scope: 'scope',
        version: 1,
        status: 'draft',
        createdBy: owner,
        constraints: ['c1'],
        standards: [],
        deliverables: ['d1'],
        openQuestions: [],
        requiredReviewers: [],
      },
    });
    planId = res.id;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('D1: POST suggestion {field:goal, action:set} → 201', async () => {
    const res = await suggestPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions`, {
        method: 'POST',
        userName: owner,
        body: { field: 'goal', action: 'set', value: 'new goal', reason: 'better' },
      }),
      { params: { projectId, planId } },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.field).toBe('goal');
    expect(body.data.action).toBe('set');
  });

  it('D2: POST suggestion {field:constraints, action:append} → 201', async () => {
    const res = await suggestPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions`, {
        method: 'POST',
        userName: owner,
        body: { field: 'constraints', action: 'append', value: 'new-constraint', reason: 'needed' },
      }),
      { params: { projectId, planId } },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.action).toBe('append');
  });

  it('D3: POST suggestion {field:deliverables, action:remove} → 201', async () => {
    const res = await suggestPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions`, {
        method: 'POST',
        userName: owner,
        body: { field: 'deliverables', action: 'remove', value: 'd1', reason: 'no longer needed' },
      }),
      { params: { projectId, planId } },
    );
    expect(res.status).toBe(201);
  });

  it('D4: suggestion on active plan → 400 STATE_CONFLICT', async () => {
    const { planId: activePlanId } = await createActivePlan(projectId, owner);
    const res = await suggestPost(
      makeReq(`/api/projects/${projectId}/plans/${activePlanId}/suggestions`, {
        method: 'POST',
        userName: owner,
        body: { field: 'goal', action: 'set', value: 'x', reason: 'y' },
      }),
      { params: { projectId, planId: activePlanId } },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('STATE_CONFLICT');
  });

  it('D8: 非法 field → 400 VALIDATION', async () => {
    const res = await suggestPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions`, {
        method: 'POST',
        userName: owner,
        body: { field: 'title', action: 'set', value: 'x', reason: 'y' },
      }),
      { params: { projectId, planId } },
    );
    expect(res.status).toBe(400);
  });

  it('D10: 缺少 reason → 400', async () => {
    const res = await suggestPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions`, {
        method: 'POST',
        userName: owner,
        body: { field: 'goal', action: 'set', value: 'x' },
      }),
      { params: { projectId, planId } },
    );
    expect(res.status).toBe(400);
  });

  it('D5: accept set suggestion → plan.goal 被替换', async () => {
    // Create a fresh set suggestion
    const createRes = await suggestPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions`, {
        method: 'POST',
        userName: owner,
        body: { field: 'goal', action: 'set', value: 'accepted goal', reason: 'better' },
      }),
      { params: { projectId, planId } },
    );
    const suggestionId = (await createRes.json()).data.id;

    const res = await resolvePost(
      makeReq(
        `/api/projects/${projectId}/plans/${planId}/suggestions/${suggestionId}?action=accept`,
        {
          method: 'POST',
          userName: owner,
          body: {},
        },
      ),
      { params: { projectId, planId, suggestionId } },
    );
    expect(res.status).toBe(200);

    // Verify plan.goal updated
    const plan = await testPrisma.plan.findUnique({ where: { id: planId } });
    expect(plan?.goal).toBe('accepted goal');
  });

  it('D7: reject suggestion → status=rejected', async () => {
    const createRes = await suggestPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions`, {
        method: 'POST',
        userName: owner,
        body: { field: 'scope', action: 'set', value: 'rejected scope', reason: 'test' },
      }),
      { params: { projectId, planId } },
    );
    const suggestionId = (await createRes.json()).data.id;

    const res = await resolvePost(
      makeReq(
        `/api/projects/${projectId}/plans/${planId}/suggestions/${suggestionId}?action=reject`,
        {
          method: 'POST',
          userName: owner,
          body: {},
        },
      ),
      { params: { projectId, planId, suggestionId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('rejected');
  });

  it('D6: accept append suggestion → constraints 数组新增元素', async () => {
    const planBefore = await testPrisma.plan.findUnique({ where: { id: planId } });
    const beforeLen = (planBefore?.constraints as string[]).length;

    const createRes = await suggestPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions`, {
        method: 'POST',
        userName: owner,
        body: { field: 'constraints', action: 'append', value: 'appended-item', reason: 'test' },
      }),
      { params: { projectId, planId } },
    );
    const suggestionId = (await createRes.json()).data.id;

    await resolvePost(
      makeReq(
        `/api/projects/${projectId}/plans/${planId}/suggestions/${suggestionId}?action=accept`,
        {
          method: 'POST',
          userName: owner,
          body: {},
        },
      ),
      { params: { projectId, planId, suggestionId } },
    );

    const planAfter = await testPrisma.plan.findUnique({ where: { id: planId } });
    expect((planAfter?.constraints as string[]).length).toBe(beforeLen + 1);
  });

  it('D13: accept 时带 resolvedComment', async () => {
    const createRes = await suggestPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions`, {
        method: 'POST',
        userName: owner,
        body: { field: 'scope', action: 'set', value: 'new scope', reason: 'test' },
      }),
      { params: { projectId, planId } },
    );
    const suggestionId = (await createRes.json()).data.id;

    const res = await resolvePost(
      makeReq(
        `/api/projects/${projectId}/plans/${planId}/suggestions/${suggestionId}?action=accept`,
        {
          method: 'POST',
          userName: owner,
          body: { comment: 'looks good to me' },
        },
      ),
      { params: { projectId, planId, suggestionId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.resolvedComment).toBe('looks good to me');
  });

  it('D11: accept set → 同字段第2个 pending → conflict', async () => {
    // Create two set suggestions on the same field
    const s1Res = await suggestPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions`, {
        method: 'POST',
        userName: owner,
        body: { field: 'scope', action: 'set', value: 'scope A', reason: 'r' },
      }),
      { params: { projectId, planId } },
    );
    const s1Id = (await s1Res.json()).data.id;

    const s2Res = await suggestPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions`, {
        method: 'POST',
        userName: owner,
        body: { field: 'scope', action: 'set', value: 'scope B', reason: 'r' },
      }),
      { params: { projectId, planId } },
    );
    const s2Id = (await s2Res.json()).data.id;

    // Accept first
    await resolvePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions/${s1Id}?action=accept`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId, suggestionId: s1Id } },
    );

    // Second should now be conflict
    const s2 = await testPrisma.planSuggestion.findUnique({ where: { id: s2Id } });
    expect(s2?.status).toBe('conflict');
  });
});

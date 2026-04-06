// L module: AI integration (plan diff)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GET as diffGet } from '@/app/api/projects/[projectId]/plans/[planId]/diff/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

// Only run AI tests when explicitly opted in with PLANSYNC_AI_TESTS=1
const HAS_AI_KEY = process.env.PLANSYNC_AI_TESTS === '1';
const itWithAI = HAS_AI_KEY ? it : it.skip;
// L3 tests "AI unavailable" graceful degradation — only meaningful when AI is NOT configured

describe('L: AI Integration (Plan Diff)', () => {
  const owner = 'ai-owner';
  let projectId: string;
  let planId: string;
  let plan2Id: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const { planId: p1Id } = await createActivePlan(projectId, owner);
    planId = p1Id;
    // Create a second plan
    const p2 = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'Plan V2 AI',
        goal: 'different goal',
        scope: 'different scope',
        version: 2,
        status: 'draft',
        createdBy: owner,
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
      },
    });
    plan2Id = p2.id;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it.skip('L3: AI unavailable → GET /diff → 200, data=null — skipped: AI is always configured via .env.local in this environment', async () => {
    // This tests the graceful degradation behavior when AI fails (no key or invalid key)
    const res = await diffGet(
      makeReq(`/api/projects/${projectId}/plans/${planId}/diff`, {
        userName: owner,
        searchParams: { compareWith: plan2Id },
      }),
      { params: { projectId, planId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeNull();
  });

  it('L6边: GET /diff without compareWith → 400', async () => {
    const res = await diffGet(
      makeReq(`/api/projects/${projectId}/plans/${planId}/diff`, {
        userName: owner,
      }),
      { params: { projectId, planId } },
    );
    expect(res.status).toBe(400);
  });

  it('L6边: GET /diff with non-existent planId → 404', async () => {
    const res = await diffGet(
      makeReq(`/api/projects/${projectId}/plans/nonexistent-plan/diff`, {
        userName: owner,
        searchParams: { compareWith: plan2Id },
      }),
      { params: { projectId, planId: 'nonexistent-plan' } },
    );
    expect(res.status).toBe(404);
  });

  itWithAI('L6: GET /diff → real AI diff result with changes and summary', async () => {
    const res = await diffGet(
      makeReq(`/api/projects/${projectId}/plans/${planId}/diff`, {
        userName: owner,
        searchParams: { compareWith: plan2Id },
      }),
      { params: { projectId, planId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).not.toBeNull();
    expect(Array.isArray(body.data.changes)).toBe(true);
    expect(typeof body.data.summary).toBe('string');
  });

  itWithAI('L7: same pair second call → cached from DB', async () => {
    // First call
    await diffGet(
      makeReq(`/api/projects/${projectId}/plans/${planId}/diff`, {
        userName: owner,
        searchParams: { compareWith: plan2Id },
      }),
      { params: { projectId, planId } },
    );
    // Second call - should be cached
    const res = await diffGet(
      makeReq(`/api/projects/${projectId}/plans/${planId}/diff`, {
        userName: owner,
        searchParams: { compareWith: plan2Id },
      }),
      { params: { projectId, planId } },
    );
    expect(res.status).toBe(200);
    // Verify DB cache exists
    const cached = await testPrisma.planDiff.findFirst({
      where: { planId, compareWithPlanId: plan2Id },
    });
    expect(cached).not.toBeNull();
  });
});

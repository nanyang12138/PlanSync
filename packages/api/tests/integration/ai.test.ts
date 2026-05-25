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

// R-124: AI tests run by default against the deterministic mock provider
// (PLANSYNC_AI_MOCK=1, set in tests/setup.ts). Opt-in to a real LLM via
// PLANSYNC_AI_TESTS=1 plus a valid LLM_API_KEY/ANTHROPIC_API_KEY.
const AI_AVAILABLE = process.env.PLANSYNC_AI_TESTS === '1' || process.env.PLANSYNC_AI_MOCK === '1';
const itWithAI = AI_AVAILABLE ? it : it.skip;
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
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeNull();
  });

  it('L6边: GET /diff without compareWith → defaults to predecessor (200)', async () => {
    // Previous behaviour: compareWith was required → 400. Current behaviour
    // (per the original syntax-inconsistencies finding #12 fix): server
    // auto-resolves the predecessor plan version when compareWith is omitted,
    // returning 200 with diff data (or null for v1 with no predecessor).
    const res = await diffGet(
      makeReq(`/api/projects/${projectId}/plans/${planId}/diff`, {
        userName: owner,
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(res.status).toBe(200);
  });

  it('L6边: GET /diff with non-existent planId → 404', async () => {
    const res = await diffGet(
      makeReq(`/api/projects/${projectId}/plans/nonexistent-plan/diff`, {
        userName: owner,
        searchParams: { compareWith: plan2Id },
      }),
      { params: Promise.resolve({ projectId, planId: 'nonexistent-plan' }) },
    );
    expect(res.status).toBe(404);
  });

  itWithAI('L6: GET /diff → real AI diff result with changes and summary', async () => {
    const res = await diffGet(
      makeReq(`/api/projects/${projectId}/plans/${planId}/diff`, {
        userName: owner,
        searchParams: { compareWith: plan2Id },
      }),
      { params: Promise.resolve({ projectId, planId }) },
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
      { params: Promise.resolve({ projectId, planId }) },
    );
    // Second call - should be cached
    const res = await diffGet(
      makeReq(`/api/projects/${projectId}/plans/${planId}/diff`, {
        userName: owner,
        searchParams: { compareWith: plan2Id },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(res.status).toBe(200);
    // Verify DB cache exists. The route calls
    //   getOrCreatePlanDiff(projectId, compareWith, params.planId)
    // which stores fromPlanId=compareWith (=plan2Id), toPlanId=planId.
    // (R-124: this query was reversed in the original test, which went
    // undetected because L7 used to skip without an AI key.)
    const cached = await testPrisma.planDiff.findFirst({
      where: { fromPlanId: plan2Id, toPlanId: planId },
    });
    expect(cached).not.toBeNull();
  });
});

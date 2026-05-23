/**
 * R-143: completion-verify observability — score / breakdown / feedback /
 * model must be persisted on every verification outcome, and 422 responses
 * must echo `runId` so the UI can deep-link to the failed verification.
 *
 * Three outcomes covered:
 *   - AI says "not verified, score < 75" → 422, response body has runId,
 *     DB row has score / breakdown / feedback / model populated.
 *   - AI says "verified, score ≥ 75" → 200, DB row has the AI fields.
 *   - AI returns null (unavailable) → run completes, DB row records
 *     feedback='AI unavailable, allowed through'.
 *
 * The aiClient module is mocked at the boundary so the tests do not need a
 * live LLM and run deterministically.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// IMPORTANT: vi.mock is hoisted, so the factory must avoid referencing
// outer-scope variables. We toggle behaviour through an exported handle.
type MockState = {
  nextResult: string | null;
  modelName: string | null;
};
const mockState: MockState = { nextResult: null, modelName: 'mock-model-v1' };

vi.mock('@/lib/ai/client', () => ({
  aiClient: {
    get isAvailable() {
      return mockState.modelName !== null;
    },
    get providerName() {
      return mockState.modelName ? 'mock' : 'none';
    },
    get modelName() {
      return mockState.modelName;
    },
    complete: vi.fn(async () => mockState.nextResult),
  },
}));

import { POST as runActionPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/[runId]/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('R-143: completion-verify observability', () => {
  const owner = 'r143-owner';
  const agentName = 'r143-agent';
  let projectId: string;
  let taskId: string;
  let planVersion: number;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const { version } = await createActivePlan(projectId, owner);
    planVersion = version;

    await testPrisma.projectMember.create({
      data: { projectId, name: agentName, role: 'developer', type: 'agent' },
    });

    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'R-143 agent task',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: agentName,
        assigneeType: 'agent',
        boundPlanVersion: planVersion,
        agentConstraints: [],
        expectedOutput: 'A working implementation with tests',
        planDeliverableRefs: ['Deliverable A'],
      },
    });
    taskId = task.id;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  beforeEach(async () => {
    // Each test creates and completes its own run; clear any prior runs on
    // the task so the "one running per task" partial unique index does not
    // bite the next case.
    await testPrisma.executionRun.deleteMany({ where: { taskId } });
    mockState.nextResult = null;
    mockState.modelName = 'mock-model-v1';
  });

  async function startRun() {
    const run = await testPrisma.executionRun.create({
      data: {
        taskId,
        status: 'running',
        executorType: 'agent',
        executorName: agentName,
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(),
      },
    });
    return run.id;
  }

  it('422 response echoes runId; DB row records score / breakdown / feedback / model', async () => {
    mockState.nextResult = JSON.stringify({
      verified: false,
      score: 42,
      breakdown: { specificity: 30, coherence: 50, coverage: 40 },
      gaps: ['no tests written'],
      feedback: 'Evidence too thin to confirm Deliverable A is met.',
    });

    const runId = await startRun();

    const res = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: {
          status: 'completed',
          outputSummary: 'done',
          deliverablesMet: ['Deliverable A: implemented foo'],
        },
      }),
      { params: { projectId, taskId, runId } },
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('COMPLETION_VERIFICATION_FAILED');
    // The runId echo is the core R-143 contract: clients need it to deep-link
    // to the failed run's audit record. Before R-143 the 422 response body
    // dropped this entirely.
    expect(body.error.details.runId).toBe(runId);
    expect(body.error.details.score).toBe(42);
    expect(body.error.details.breakdown).toEqual({
      specificity: 30,
      coherence: 50,
      coverage: 40,
    });
    expect(body.error.details.model).toBe('mock-model-v1');

    const persisted = await testPrisma.executionRun.findUnique({ where: { id: runId } });
    expect(persisted?.aiVerifyScore).toBe(42);
    expect(persisted?.aiVerifyBreakdown).toEqual({
      specificity: 30,
      coherence: 50,
      coverage: 40,
    });
    expect(persisted?.aiVerifyFeedback).toMatch(/Evidence too thin/);
    expect(persisted?.aiVerifyModel).toBe('mock-model-v1');
    // 422 must NOT mark the run completed — the finalize updateMany is
    // gated behind the early return.
    expect(persisted?.status).toBe('running');
    expect(persisted?.endedAt).toBeNull();
  });

  it('verified pass writes the AI fields and lets the run complete', async () => {
    mockState.nextResult = JSON.stringify({
      verified: true,
      score: 88,
      breakdown: { specificity: 90, coherence: 85, coverage: 90 },
      gaps: [],
      feedback: 'Looks good.',
    });

    const runId = await startRun();

    // Reset the task to in_progress so the previous test's leftover state
    // (a 422 leaves the task untouched, but a later case might set done)
    // does not block this run.
    await testPrisma.task.update({ where: { id: taskId }, data: { status: 'in_progress' } });

    const res = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: {
          status: 'completed',
          outputSummary: 'done',
          deliverablesMet: ['Deliverable A: implemented foo with tests'],
        },
      }),
      { params: { projectId, taskId, runId } },
    );

    expect(res.status).toBe(200);

    const persisted = await testPrisma.executionRun.findUnique({ where: { id: runId } });
    expect(persisted?.aiVerifyScore).toBe(88);
    expect(persisted?.aiVerifyBreakdown).toEqual({
      specificity: 90,
      coherence: 85,
      coverage: 90,
    });
    expect(persisted?.aiVerifyFeedback).toMatch(/Looks good/);
    expect(persisted?.aiVerifyModel).toBe('mock-model-v1');
    expect(persisted?.status).toBe('completed');
  });

  // ---- #184 / #185 — JSON.parse + audit catch isolation -------------------

  it('#184/#185: AI returns malformed JSON → soft-allow (200), not 422', async () => {
    // Phase 2 failure: AI returned text but it does not parse as JSON.
    // Pre-fix this fell into the same catch as Phase 1 (AI infra error)
    // and short-circuited the verification — but that's the same outcome
    // we want, so the response code is still 200. The point of the test
    // is to lock in the audit feedback so a future refactor cannot start
    // returning 422 here (or return 500 from an unswallowed throw).
    mockState.nextResult = 'this { is not } [ json ] at all';
    mockState.modelName = 'mock-model-v1';

    const runId = await startRun();
    await testPrisma.task.update({ where: { id: taskId }, data: { status: 'in_progress' } });

    const res = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: {
          status: 'completed',
          outputSummary: 'done',
          deliverablesMet: ['Deliverable A: implemented foo'],
        },
      }),
      { params: { projectId, taskId, runId } },
    );

    expect(res.status).toBe(200);
    const persisted = await testPrisma.executionRun.findUnique({ where: { id: runId } });
    expect(persisted?.aiVerifyScore).toBeNull();
    expect(persisted?.aiVerifyFeedback).toMatch(/malformed JSON, allowed through/);
    expect(persisted?.aiVerifyModel).toBe('mock-model-v1');
    expect(persisted?.status).toBe('completed');
  });

  it('#184: a thrown audit-write does NOT mask a real 422 (verification result is authoritative)', async () => {
    // The original bug: prisma.executionRun.update was inside the same try
    // as the AI call + JSON.parse + 422 NextResponse. If the audit update
    // happened to throw (Prisma transient connection drop, accidental
    // schema breakage, race with another writer), the catch logged "AI
    // failed, allowed through" and the request fell through to finalize
    // — silently bypassing a real verification failure (score < 75).
    //
    // Simulate by spying on prisma.executionRun.update so the FIRST call
    // (the audit) throws, while subsequent calls work normally (the
    // finalize path needs them).
    const updateSpy = vi.spyOn(testPrisma.executionRun, 'update');
    let throwOnce = true;
    updateSpy.mockImplementationOnce(((args: unknown) => {
      if (throwOnce) {
        throwOnce = false;
        return Promise.reject(new Error('simulated DB drop during audit write'));
      }
      // fall through to the real implementation for any subsequent call
      return testPrisma.executionRun.update.call(testPrisma.executionRun, args as never);
    }) as never);

    mockState.nextResult = JSON.stringify({
      verified: false,
      score: 30,
      breakdown: { specificity: 30, coherence: 30, coverage: 30 },
      gaps: ['no evidence'],
      feedback: 'Score too low.',
    });
    mockState.modelName = 'mock-model-v1';

    const runId = await startRun();
    await testPrisma.task.update({ where: { id: taskId }, data: { status: 'in_progress' } });

    try {
      const res = await runActionPost(
        makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`, {
          method: 'POST',
          userName: owner,
          body: {
            status: 'completed',
            outputSummary: 'done',
            deliverablesMet: ['Deliverable A: implemented foo'],
          },
        }),
        { params: { projectId, taskId, runId } },
      );

      // Verification result must win even though the audit write failed.
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe('COMPLETION_VERIFICATION_FAILED');
      expect(body.error.details.score).toBe(30);
    } finally {
      updateSpy.mockRestore();
    }
  });

  it('AI unavailable (raw === null) records feedback="AI unavailable, allowed through"', async () => {
    mockState.nextResult = null;
    mockState.modelName = null;

    const runId = await startRun();
    await testPrisma.task.update({ where: { id: taskId }, data: { status: 'in_progress' } });

    const res = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: {
          status: 'completed',
          outputSummary: 'done',
          deliverablesMet: ['Deliverable A: implemented foo'],
        },
      }),
      { params: { projectId, taskId, runId } },
    );

    expect(res.status).toBe(200);

    const persisted = await testPrisma.executionRun.findUnique({ where: { id: runId } });
    expect(persisted?.aiVerifyScore).toBeNull();
    expect(persisted?.aiVerifyBreakdown).toBeNull();
    expect(persisted?.aiVerifyFeedback).toBe('AI unavailable, allowed through');
    expect(persisted?.aiVerifyModel).toBeNull();
    expect(persisted?.status).toBe('completed');
  });
});

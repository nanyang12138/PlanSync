/**
 * R-184: complete-route response envelope distinguishes the rule gate
 * (R-181) from the AI-low-score advisory (R-180).
 *
 * The contract this suite pins down (also called out in the docs/REMEDIATION_PLAN.md
 * R-184 verification line):
 *
 *   - rule gate hit            → 422 with `error.gate === 'rule'` and a
 *                                 `details.failedRules: [{ ruleId, ... }]`
 *                                 array. The run stays running and the task
 *                                 stays in_progress.
 *   - AI verification advisory → 200 with `advisory.kind === 'ai_low_score'`
 *                                 plus the score / feedback / runReviewId
 *                                 the CLI/UI need to render the soft hint.
 *                                 The run finalizes (R-180 advisory contract).
 *   - both clean               → 200 with NO `advisory` field at all.
 *
 * The rule gate test is intentionally isolated from the AI advisory: we
 * stub the AI verifier to "verified=true, score=95" so a rule failure is
 * the only thing that can produce 422, and we assert the full envelope
 * shape including the new `gate: 'rule'` discriminator. The advisory test
 * runs without any rules and stubs the verifier to a low score so the
 * route writes a `RunReview` row AND mirrors the advisory into the
 * 200 response (the new R-184 behaviour — pre-R-184 the advisory was
 * persisted but never echoed in the body, so CLI / UI had no signal to
 * branch on without an extra round-trip).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

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

describe('R-184: advisory vs rule-gate envelope', () => {
  const owner = 'r184-owner';
  const agentName = 'r184-agent';
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
        title: 'R-184 agent task',
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
    await testPrisma.verificationRule.deleteMany({ where: { projectId } });
    await testPrisma.runReview.deleteMany({ where: { run: { taskId } } });
    await testPrisma.executionRun.deleteMany({ where: { taskId } });
    await testPrisma.task.update({
      where: { id: taskId },
      data: { status: 'in_progress', prUrl: null },
    });
    mockState.modelName = 'mock-model-v1';
    mockState.nextResult = null;
    const ai = await import('@/lib/ai/client');
    const completeFn = ai.aiClient.complete as unknown as ReturnType<typeof vi.fn>;
    completeFn.mockClear();
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

  it('rule gate failure → 422 body has gate=rule and ruleId in failedRules; no AI advisory leaks', async () => {
    // Stub the AI verifier to a clean pass so it cannot also fire an
    // advisory and confuse the rule-gate-only assertion.
    mockState.nextResult = JSON.stringify({
      verified: true,
      score: 95,
      breakdown: { specificity: 95, coherence: 95, coverage: 95 },
      gaps: [],
      feedback: 'looks good',
    });

    const created = await testPrisma.verificationRule.create({
      data: {
        projectId,
        kind: 'require_files_changed',
        scope: 'project',
        enabled: true,
        createdBy: owner,
      },
    });

    const runId = await startRun();
    const res = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: {
          status: 'completed',
          outputSummary: 'wrote it',
          filesChanged: [],
          deliverablesMet: ['Deliverable A: did it'],
        },
      }),
      { params: Promise.resolve({ projectId, taskId, runId }) },
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    // R-184 hard-gate envelope: gate === 'rule' is the discriminator
    // CLI/UI use to pick a 'red' rendering. The pre-R-184 envelope was
    // missing this discriminator and clients had to inspect error.code.
    expect(json.error.code).toBe('VERIFICATION_RULE_FAILED');
    expect(json.error.gate).toBe('rule');
    expect(Array.isArray(json.error.details?.failedRules)).toBe(true);
    expect(json.error.details.failedRules[0].ruleId).toBe(created.id);
    expect(json.error.details.failedRules[0].kind).toBe('require_files_changed');
    // The 422 envelope must NOT carry an `advisory` field — that is
    // strictly the 200-path channel (avoids two distinct UI paths
    // conflating "rule failed" with "AI advisory").
    expect(json.advisory).toBeUndefined();
    expect((json.error as { advisory?: unknown }).advisory).toBeUndefined();
  });

  it('AI low-score advisory → 200 with advisory.kind === "ai_low_score" and a runReviewId pointing at the persisted RunReview', async () => {
    // No verification rules in this project — the AI advisory is the
    // only signal under test. R-180 says complete still returns 200
    // with a low score; R-184 adds the response-side echo so clients
    // can render an advisory chip without an extra GET.
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
          outputSummary: 'wrote it with light evidence',
          filesChanged: ['src/foo.ts'],
          deliverablesMet: ['Deliverable A: implemented foo'],
        },
      }),
      { params: Promise.resolve({ projectId, taskId, runId }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    // Run finalized — R-180 contract preserved.
    expect(json.data?.status).toBe('completed');
    // R-184 contract: advisory is echoed back in the 200 envelope.
    expect(json.advisory).toBeDefined();
    expect(json.advisory.kind).toBe('ai_low_score');
    expect(json.advisory.score).toBe(42);
    expect(json.advisory.feedback).toMatch(/Evidence too thin/);
    // Best-effort runReviewId — present when the RunReview write
    // succeeds. We assert it points at the actual row written by the
    // route so the CLI can fetch the review without a list scan.
    expect(typeof json.advisory.runReviewId).toBe('string');
    const review = await testPrisma.runReview.findUnique({
      where: { id: json.advisory.runReviewId },
    });
    expect(review?.runId).toBe(runId);
    expect(review?.kind).toBe('ai_verification');
    expect(review?.score).toBe(42);
  });

  it('verified pass with no rules → 200 has no advisory field (clean run is silent)', async () => {
    // The "no advisory key in body" half of the contract: clients that
    // branch on `if (json.advisory)` must not see a stale advisory from
    // a prior turn.
    mockState.nextResult = JSON.stringify({
      verified: true,
      score: 92,
      breakdown: { specificity: 90, coherence: 90, coverage: 90 },
      gaps: [],
      feedback: 'all good',
    });

    const runId = await startRun();
    const res = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: {
          status: 'completed',
          outputSummary: 'wrote it with strong evidence',
          filesChanged: ['src/foo.ts', 'tests/foo.test.ts'],
          deliverablesMet: ['Deliverable A: implemented foo with tests'],
        },
      }),
      { params: Promise.resolve({ projectId, taskId, runId }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data?.status).toBe('completed');
    expect(json.advisory).toBeUndefined();
    // No RunReview row is written for a clean pass — same as R-143
    // already pins down. Re-asserted here so a regression that starts
    // emitting an advisory for passing runs trips this test as well.
    const reviews = await testPrisma.runReview.findMany({ where: { runId } });
    expect(reviews).toHaveLength(0);
  });
});

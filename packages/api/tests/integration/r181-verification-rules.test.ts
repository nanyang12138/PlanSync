/**
 * R-181: declarative verification rules — evaluator + complete gate +
 * owner CRUD.
 *
 * Covers the three pieces of the spec's verification line:
 *   "vitest: require_files_changed 在空 filesChanged 时拒绝；规则可被 owner 关闭"
 *
 *   1. The evaluator (pure) returns ok=false for an empty filesChanged
 *      list and ok=true once at least one entry is present.
 *   2. The complete endpoint returns 422 with `{ gate: 'rule', failedRules }`
 *      when a rule fails; the run stays running and the task stays
 *      in_progress so the agent (or owner) can retry.
 *   3. Disabling the rule via PATCH `{ enabled: false }` lets the same
 *      complete payload through.
 *   4. min_output_summary_chars exercises the params-driven kind so the
 *      JSONB params path is not regressed.
 *
 * The AI completion-verify path is mocked the same way r143 does it so
 * a "verified" advisory write does not change the gate outcome.
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
  POST as createRulePost,
  GET as listRulesGet,
} from '@/app/api/projects/[projectId]/verification-rules/route';
import {
  PATCH as patchRule,
  DELETE as deleteRule,
} from '@/app/api/projects/[projectId]/verification-rules/[ruleId]/route';
import {
  evaluateRule,
  evaluateProjectVerificationRules,
} from '@/lib/verification-rules';
import type { VerificationRule } from '@prisma/client';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('R-181: verification rules gate', () => {
  const owner = 'r181-owner';
  const developer = 'r181-dev';
  const agentName = 'r181-agent';
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
    await testPrisma.projectMember.create({
      data: { projectId, name: developer, role: 'developer', type: 'human' },
    });

    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'R-181 agent task',
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
    // Each test starts with a fresh rule set and a fresh run so the
    // "one running per task" partial unique index never bites and prior
    // gate verdicts don't leak.
    await testPrisma.verificationRule.deleteMany({ where: { projectId } });
    await testPrisma.executionRun.deleteMany({ where: { taskId } });
    await testPrisma.task.update({
      where: { id: taskId },
      data: { status: 'in_progress', prUrl: null },
    });
    // Stub the AI verifier to return a clean "verified" — that keeps
    // the AI-advisory path quiet so a rule 422 is the only possible
    // failure cause in these cases.
    mockState.nextResult = JSON.stringify({
      verified: true,
      score: 95,
      breakdown: { specificity: 95, coherence: 95, coverage: 95 },
      gaps: [],
      feedback: 'looks good',
    });
    mockState.modelName = 'mock-model-v1';
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

  // ---------------------------------------------------------------
  // Pure evaluator unit checks
  // ---------------------------------------------------------------

  it('evaluateRule(require_files_changed) rejects empty filesChanged and accepts non-empty', () => {
    const baseRule: VerificationRule = {
      id: 'rule-files',
      projectId,
      scope: 'project',
      scopeValue: null,
      kind: 'require_files_changed',
      params: {},
      enabled: true,
      createdBy: owner,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const taskCtx = {
      id: taskId,
      type: 'code',
      prUrl: null,
      planDeliverableRefs: ['Deliverable A'],
    };

    const empty = evaluateRule(baseRule, {
      task: taskCtx,
      body: { filesChanged: [], deliverablesMet: ['Deliverable A: did it'] },
    });
    expect(empty.ok).toBe(false);
    expect(empty.message).toMatch(/require_files_changed/);

    const filled = evaluateRule(baseRule, {
      task: taskCtx,
      body: {
        filesChanged: ['src/foo.ts'],
        deliverablesMet: ['Deliverable A: did it'],
      },
    });
    expect(filled.ok).toBe(true);
  });

  it('evaluateRule(min_output_summary_chars) honours params.min', () => {
    const rule: VerificationRule = {
      id: 'rule-summary',
      projectId,
      scope: 'project',
      scopeValue: null,
      kind: 'min_output_summary_chars',
      params: { min: 40 },
      enabled: true,
      createdBy: owner,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const taskCtx = {
      id: taskId,
      type: 'code',
      prUrl: null,
      planDeliverableRefs: [],
    };
    const tooShort = evaluateRule(rule, {
      task: taskCtx,
      body: { outputSummary: 'done.' },
    });
    expect(tooShort.ok).toBe(false);
    const longEnough = evaluateRule(rule, {
      task: taskCtx,
      body: { outputSummary: 'x'.repeat(50) },
    });
    expect(longEnough.ok).toBe(true);
  });

  it('evaluateProjectVerificationRules() only returns enabled rules', async () => {
    await testPrisma.verificationRule.create({
      data: {
        projectId,
        kind: 'require_files_changed',
        scope: 'project',
        enabled: true,
        createdBy: owner,
      },
    });
    await testPrisma.verificationRule.create({
      data: {
        projectId,
        kind: 'min_output_summary_chars',
        scope: 'project',
        params: { min: 9999 },
        enabled: false,
        createdBy: owner,
      },
    });
    const result = await evaluateProjectVerificationRules(projectId, {
      task: {
        id: taskId,
        type: 'code',
        prUrl: null,
        planDeliverableRefs: ['Deliverable A'],
      },
      body: { outputSummary: 'short', filesChanged: ['x.ts'] },
    });
    expect(result.evaluated).toHaveLength(1);
    expect(result.evaluated[0]?.kind).toBe('require_files_changed');
  });

  // ---------------------------------------------------------------
  // End-to-end: complete endpoint actually 422s and respects toggle
  // ---------------------------------------------------------------

  it('complete returns 422 with gate=rule when require_files_changed fails (spec core case)', async () => {
    await testPrisma.verificationRule.create({
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
      { params: { projectId, taskId, runId } },
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe('VERIFICATION_RULE_FAILED');
    expect(json.error.gate).toBe('rule');
    expect(Array.isArray(json.error.details?.failedRules)).toBe(true);
    expect(json.error.details.failedRules[0].kind).toBe('require_files_changed');

    // The run must NOT have finalized — pre-R-181 this whole code path
    // didn't exist, so a regression that silently 200s here would be
    // invisible without this assertion.
    const persisted = await testPrisma.executionRun.findUnique({ where: { id: runId } });
    expect(persisted?.status).toBe('running');
    expect(persisted?.endedAt).toBeNull();
    const taskAfter = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(taskAfter?.status).toBe('in_progress');
  });

  it('owner disabling the rule via PATCH lets the same payload through', async () => {
    // Create the rule via the API surface so the route-level wiring is
    // exercised end-to-end (the unit tests above already cover the
    // evaluator directly).
    const createRes = await createRulePost(
      makeReq(`/api/projects/${projectId}/verification-rules`, {
        method: 'POST',
        userName: owner,
        body: { kind: 'require_files_changed', scope: 'project' },
      }),
      { params: { projectId } },
    );
    expect(createRes.status).toBe(201);
    const createdJson = await createRes.json();
    const ruleId: string = createdJson.data.id;

    // Sanity: the gate is on.
    {
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
        { params: { projectId, taskId, runId } },
      );
      expect(res.status).toBe(422);
    }

    // Owner disables the rule.
    const disableRes = await patchRule(
      makeReq(`/api/projects/${projectId}/verification-rules/${ruleId}`, {
        method: 'PATCH',
        userName: owner,
        body: { enabled: false },
      }),
      { params: { projectId, ruleId } },
    );
    expect(disableRes.status).toBe(200);

    // Re-attempt with the same gate-failing payload — must now succeed.
    await testPrisma.executionRun.deleteMany({ where: { taskId } });
    await testPrisma.task.update({ where: { id: taskId }, data: { status: 'in_progress' } });
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
      { params: { projectId, taskId, runId } },
    );
    expect(res.status).toBe(200);
    const persisted = await testPrisma.executionRun.findUnique({ where: { id: runId } });
    expect(persisted?.status).toBe('completed');
  });

  it('GET lists rules for the owner and DELETE removes them', async () => {
    await testPrisma.verificationRule.create({
      data: {
        projectId,
        kind: 'require_files_changed',
        scope: 'project',
        enabled: true,
        createdBy: owner,
      },
    });
    const listRes = await listRulesGet(
      makeReq(`/api/projects/${projectId}/verification-rules`, {
        method: 'GET',
        userName: owner,
      }),
      { params: { projectId } },
    );
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.data).toHaveLength(1);
    const ruleId: string = listJson.data[0].id;

    const delRes = await deleteRule(
      makeReq(`/api/projects/${projectId}/verification-rules/${ruleId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: { projectId, ruleId } },
    );
    expect(delRes.status).toBe(200);
    const after = await testPrisma.verificationRule.count({ where: { projectId } });
    expect(after).toBe(0);
  });

  it('non-owner cannot create rules', async () => {
    const res = await createRulePost(
      makeReq(`/api/projects/${projectId}/verification-rules`, {
        method: 'POST',
        userName: developer,
        body: { kind: 'require_files_changed', scope: 'project' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(403);
  });

  it('POST rejects unknown kind', async () => {
    const res = await createRulePost(
      makeReq(`/api/projects/${projectId}/verification-rules`, {
        method: 'POST',
        userName: owner,
        body: { kind: 'not_a_real_kind', scope: 'project' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(400);
  });
});

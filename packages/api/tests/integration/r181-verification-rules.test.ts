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
import { evaluateRule, evaluateProjectVerificationRules } from '@/lib/verification-rules';
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

  // ---------------------------------------------------------------
  // R-208: require_pr_merged / require_commits_on_branch are no longer
  // string-presence theater — they consume webhook-verified signals.
  // ---------------------------------------------------------------

  function ruleRow(kind: string): VerificationRule {
    return {
      id: `rule-${kind}`,
      projectId,
      scope: 'project',
      scopeValue: null,
      kind,
      params: {},
      enabled: true,
      createdBy: owner,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as VerificationRule;
  }

  it('evaluateRule(require_pr_merged) needs verified.prMerged, not just a prUrl (R-208)', () => {
    const rule = ruleRow('require_pr_merged');
    const taskCtx = {
      id: taskId,
      type: 'code',
      prUrl: 'https://github.com/o/r/pull/1',
      planDeliverableRefs: [],
    };
    // prUrl set but the PR is NOT verified-merged → fail closed (the old
    // code passed here purely because prUrl was non-empty).
    const notMerged = evaluateRule(rule, {
      task: taskCtx,
      body: {},
      verified: { prMerged: false },
    });
    expect(notMerged.ok).toBe(false);
    expect(notMerged.message).toMatch(/not merged/i);
    // verified merged → pass
    const merged = evaluateRule(rule, { task: taskCtx, body: {}, verified: { prMerged: true } });
    expect(merged.ok).toBe(true);
    // no verified signal at all (e.g. no prUrl) → fail closed
    const none = evaluateRule(rule, {
      task: { ...taskCtx, prUrl: null },
      body: {},
    });
    expect(none.ok).toBe(false);
  });

  it('evaluateRule(require_commits_on_branch) needs verified.branchHasCommits, not just a name (R-208)', () => {
    const rule = ruleRow('require_commits_on_branch');
    const taskCtx = { id: taskId, type: 'code', prUrl: null, planDeliverableRefs: [] };
    // branchName provided but no verified push → fail closed (the old code
    // passed on the mere presence of the string).
    const noPush = evaluateRule(rule, {
      task: taskCtx,
      body: { branchName: 'feature-x' },
      verified: { branchHasCommits: false },
    });
    expect(noPush.ok).toBe(false);
    expect(noPush.message).toMatch(/no pushed commits/i);
    // verified push → pass
    const pushed = evaluateRule(rule, {
      task: taskCtx,
      body: { branchName: 'feature-x' },
      verified: { branchHasCommits: true },
    });
    expect(pushed.ok).toBe(true);
  });

  it('evaluateRule(require_commits_on_branch) rejects mainline branches even with a verified push (#2930)', () => {
    const rule = ruleRow('require_commits_on_branch');
    const taskCtx = { id: taskId, type: 'code', prUrl: null, planDeliverableRefs: [] };
    // Pushing to the shared mainline (master/main) must NOT satisfy the
    // gate — even if the webhook signal says commits landed on it, that is
    // not evidence of isolated task work (the "代理可提交 master" bypass).
    for (const mainline of ['master', 'main', 'MAIN', 'refs/heads/master']) {
      const result = evaluateRule(rule, {
        task: taskCtx,
        body: { branchName: mainline },
        verified: { branchHasCommits: true },
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/mainline/i);
    }
  });

  it('evaluateProjectVerificationRules(require_pr_merged) reads the merged-PR webhook event (R-208)', async () => {
    await testPrisma.domainEvent.deleteMany({ where: { projectId } });
    await testPrisma.verificationRule.create({
      data: {
        projectId,
        kind: 'require_pr_merged',
        scope: 'project',
        enabled: true,
        createdBy: owner,
      },
    });
    const prUrl = 'https://github.com/o/r/pull/42';
    const taskCtx = { id: taskId, type: 'code', prUrl, planDeliverableRefs: [] };

    // No webhook event yet → the PR cannot be proven merged → fail.
    const before = await evaluateProjectVerificationRules(projectId, { task: taskCtx, body: {} });
    expect(before.failed.map((f) => f.kind)).toContain('require_pr_merged');

    // A merged pull_request event lands in the outbox → now it passes.
    await testPrisma.domainEvent.create({
      data: {
        eventType: 'github_pull_request',
        projectId,
        payload: {
          type: 'github_pull_request',
          projectId,
          userName: null,
          data: {
            deliveryId: 'r208-pr-1',
            repository: 'o/r',
            payload: {
              action: 'closed',
              pull_request: {
                merged: true,
                html_url: prUrl,
                merge_commit_sha: 'sha-merge-1',
                head: { sha: 'sha-head-1' },
                base: { ref: 'master' },
              },
            },
          },
        },
      },
    });
    const after = await evaluateProjectVerificationRules(projectId, { task: taskCtx, body: {} });
    expect(after.failed).toHaveLength(0);
    await testPrisma.domainEvent.deleteMany({ where: { projectId } });
  });

  it('evaluateProjectVerificationRules(require_commits_on_branch) reads the push webhook event (R-208)', async () => {
    await testPrisma.domainEvent.deleteMany({ where: { projectId } });
    await testPrisma.verificationRule.create({
      data: {
        projectId,
        kind: 'require_commits_on_branch',
        scope: 'project',
        enabled: true,
        createdBy: owner,
      },
    });
    const taskCtx = { id: taskId, type: 'code', prUrl: null, planDeliverableRefs: [] };
    const body = { branchName: 'cursor/fix-rf-1-abcd' };

    // No push event yet → fail.
    const before = await evaluateProjectVerificationRules(projectId, { task: taskCtx, body });
    expect(before.failed.map((f) => f.kind)).toContain('require_commits_on_branch');

    // A github_push with a commit to that branch lands → now it passes.
    await testPrisma.domainEvent.create({
      data: {
        eventType: 'github_push',
        projectId,
        payload: {
          type: 'github_push',
          projectId,
          userName: null,
          data: {
            deliveryId: 'r208-push-1',
            repository: 'o/r',
            payload: {
              ref: 'refs/heads/cursor/fix-rf-1-abcd',
              commits: [{ id: 'c1' }],
              head_commit: { id: 'c1' },
            },
          },
        },
      },
    });
    const after = await evaluateProjectVerificationRules(projectId, { task: taskCtx, body });
    expect(after.failed).toHaveLength(0);

    // An empty-commits push to the same branch must NOT satisfy the rule.
    await testPrisma.domainEvent.deleteMany({ where: { projectId } });
    await testPrisma.domainEvent.create({
      data: {
        eventType: 'github_push',
        projectId,
        payload: {
          type: 'github_push',
          projectId,
          userName: null,
          data: {
            deliveryId: 'r208-push-2',
            repository: 'o/r',
            payload: { ref: 'refs/heads/cursor/fix-rf-1-abcd', commits: [], head_commit: null },
          },
        },
      },
    });
    const empty = await evaluateProjectVerificationRules(projectId, { task: taskCtx, body });
    expect(empty.failed.map((f) => f.kind)).toContain('require_commits_on_branch');
    await testPrisma.domainEvent.deleteMany({ where: { projectId } });
  });

  it('require_commits_on_branch scopes push evidence to run.startedAt — a stale pre-run push does NOT pass (#2925)', async () => {
    await testPrisma.domainEvent.deleteMany({ where: { projectId } });
    await testPrisma.verificationRule.create({
      data: {
        projectId,
        kind: 'require_commits_on_branch',
        scope: 'project',
        enabled: true,
        createdBy: owner,
      },
    });
    const taskCtx = { id: taskId, type: 'code', prUrl: null, planDeliverableRefs: [] };
    const body = { branchName: 'cursor/recycled-branch' };

    // A real push with commits to that branch — but recorded LONG before the
    // current run started (e.g. a previous run reused the same branch name).
    await testPrisma.domainEvent.create({
      data: {
        eventType: 'github_push',
        projectId,
        createdAt: new Date('2020-01-01T00:00:00Z'),
        payload: {
          type: 'github_push',
          projectId,
          userName: null,
          data: {
            deliveryId: '2925-stale-push',
            repository: 'o/r',
            payload: {
              ref: 'refs/heads/cursor/recycled-branch',
              commits: [{ id: 'old1' }],
              head_commit: { id: 'old1' },
            },
          },
        },
      },
    });

    // Unscoped (no run) → the historical push still satisfies the rule.
    const unscoped = await evaluateProjectVerificationRules(projectId, { task: taskCtx, body });
    expect(unscoped.failed).toHaveLength(0);

    // Scoped to a run that started in 2026 → the 2020 push is excluded → fail.
    const runStartedAt = new Date('2026-01-01T00:00:00Z');
    const scoped = await evaluateProjectVerificationRules(projectId, {
      task: taskCtx,
      body,
      run: { startedAt: runStartedAt },
    });
    expect(scoped.failed.map((f) => f.kind)).toContain('require_commits_on_branch');

    // A fresh push recorded after the run started → passes the scoped gate.
    await testPrisma.domainEvent.create({
      data: {
        eventType: 'github_push',
        projectId,
        createdAt: new Date('2026-02-01T00:00:00Z'),
        payload: {
          type: 'github_push',
          projectId,
          userName: null,
          data: {
            deliveryId: '2925-fresh-push',
            repository: 'o/r',
            payload: {
              ref: 'refs/heads/cursor/recycled-branch',
              commits: [{ id: 'new1' }],
              head_commit: { id: 'new1' },
            },
          },
        },
      },
    });
    const afterFresh = await evaluateProjectVerificationRules(projectId, {
      task: taskCtx,
      body,
      run: { startedAt: runStartedAt },
    });
    expect(afterFresh.failed).toHaveLength(0);

    await testPrisma.domainEvent.deleteMany({ where: { projectId } });
  });

  it('require_commits_on_branch rejects a real push to mainline — committing to master never satisfies the gate (#2930)', async () => {
    await testPrisma.domainEvent.deleteMany({ where: { projectId } });
    await testPrisma.verificationRule.create({
      data: {
        projectId,
        kind: 'require_commits_on_branch',
        scope: 'project',
        enabled: true,
        createdBy: owner,
      },
    });
    const taskCtx = { id: taskId, type: 'code', prUrl: null, planDeliverableRefs: [] };

    // A genuine push WITH commits to the shared mainline (master) — recorded
    // well within any run window. Pre-#2930 this satisfied the rule because
    // the query matched on project + branch ref alone; the agent could clear
    // the gate by pushing a throwaway commit to master.
    await testPrisma.domainEvent.create({
      data: {
        eventType: 'github_push',
        projectId,
        payload: {
          type: 'github_push',
          projectId,
          userName: null,
          data: {
            deliveryId: '2930-master-push',
            repository: 'o/r',
            payload: {
              ref: 'refs/heads/master',
              commits: [{ id: 'm1' }],
              head_commit: { id: 'm1' },
            },
          },
        },
      },
    });

    const masterResult = await evaluateProjectVerificationRules(projectId, {
      task: taskCtx,
      body: { branchName: 'master' },
    });
    expect(masterResult.failed.map((f) => f.kind)).toContain('require_commits_on_branch');

    // A real push to a dedicated task branch still passes — the fix only
    // closes the mainline bypass, it does not break legitimate branches.
    await testPrisma.domainEvent.create({
      data: {
        eventType: 'github_push',
        projectId,
        payload: {
          type: 'github_push',
          projectId,
          userName: null,
          data: {
            deliveryId: '2930-feature-push',
            repository: 'o/r',
            payload: {
              ref: 'refs/heads/cursor/fix-2930',
              commits: [{ id: 'f1' }],
              head_commit: { id: 'f1' },
            },
          },
        },
      },
    });
    const featureResult = await evaluateProjectVerificationRules(projectId, {
      task: taskCtx,
      body: { branchName: 'cursor/fix-2930' },
    });
    expect(featureResult.failed).toHaveLength(0);

    await testPrisma.domainEvent.deleteMany({ where: { projectId } });
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
      { params: Promise.resolve({ projectId, taskId, runId }) },
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
      { params: Promise.resolve({ projectId }) },
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
        { params: Promise.resolve({ projectId, taskId, runId }) },
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
      { params: Promise.resolve({ projectId, ruleId }) },
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
      { params: Promise.resolve({ projectId, taskId, runId }) },
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
      { params: Promise.resolve({ projectId }) },
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
      { params: Promise.resolve({ projectId, ruleId }) },
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
      { params: Promise.resolve({ projectId }) },
    );
    expect(res.status).toBe(403);
  });

  // Closes #1220: the CLI's `/explain rule <id>` (R-184) calls GET
  // /verification-rules to look up the rule that the complete route's
  // gate=rule 422 envelope points at. Non-owner agents/developers are
  // the primary audience for that 422 envelope, so GET must NOT be
  // owner-only — otherwise the entire R-184 self-serve path 403s for
  // exactly the people it was built for. Mutations stay owner-only
  // (covered by 'non-owner cannot create rules' above).
  it('#1220: non-owner project members can GET the rules list (R-184 self-serve)', async () => {
    await testPrisma.verificationRule.create({
      data: {
        projectId,
        kind: 'require_files_changed',
        scope: 'project',
        enabled: true,
        createdBy: owner,
      },
    });

    // Human developer
    const devRes = await listRulesGet(
      makeReq(`/api/projects/${projectId}/verification-rules`, {
        method: 'GET',
        userName: developer,
      }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(devRes.status).toBe(200);
    const devJson = await devRes.json();
    expect(Array.isArray(devJson.data)).toBe(true);
    expect(devJson.data).toHaveLength(1);
    expect(devJson.data[0].kind).toBe('require_files_changed');

    // Agent (the actual /explain rule caller during /exec sub-sessions)
    const agentRes = await listRulesGet(
      makeReq(`/api/projects/${projectId}/verification-rules`, {
        method: 'GET',
        userName: agentName,
      }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(agentRes.status).toBe(200);
    const agentJson = await agentRes.json();
    expect(agentJson.data).toHaveLength(1);
  });

  // #1411 (PR #1447) + #2830: GET widened to any project member must NOT
  // leak the raw owner-writable JSONB `params` (or `createdBy`) to non-owner
  // members / exec agents. #2830 narrowed the projection to a per-kind
  // allowlist so agents can still see evaluator-relevant config (e.g. `min`
  // for `min_output_summary_chars` — needed for `/explain rule <id>` R-184)
  // while arbitrary owner-written keys are stripped. Owners on a non-exec
  // session still receive the raw row for the rule-edit UI/CLI.
  it('#1411 + #2830: non-owner GET sanitises params via per-kind allowlist; owner sees raw row', async () => {
    await testPrisma.verificationRule.create({
      data: {
        projectId,
        kind: 'min_output_summary_chars',
        scope: 'project',
        // Deliberately put a recognisable, "sensitive-looking" key in
        // params so a regression that returns the raw JSONB to non-owners
        // would obviously fail this assertion.
        params: { min: 100, internalSecret: 's3cret-do-not-leak' },
        enabled: true,
        createdBy: owner,
      },
    });

    // Owner (non-exec): raw row, including the full params JSONB + createdBy.
    const ownerRes = await listRulesGet(
      makeReq(`/api/projects/${projectId}/verification-rules`, {
        method: 'GET',
        userName: owner,
      }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(ownerRes.status).toBe(200);
    const ownerJson = await ownerRes.json();
    expect(ownerJson.data).toHaveLength(1);
    expect(ownerJson.data[0].params).toEqual({
      min: 100,
      internalSecret: 's3cret-do-not-leak',
    });
    expect(ownerJson.data[0].createdBy).toBe(owner);

    // Developer (non-owner human member): params is the allowlisted shape,
    // createdBy is stripped entirely.
    const devRes = await listRulesGet(
      makeReq(`/api/projects/${projectId}/verification-rules`, {
        method: 'GET',
        userName: developer,
      }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(devRes.status).toBe(200);
    const devJson = await devRes.json();
    expect(devJson.data).toHaveLength(1);
    const devRule = devJson.data[0];
    // The allowlisted field (the threshold R-184 explain needs) is present;
    // the owner-written extra key is NOT.
    expect(devRule.params).toEqual({ min: 100 });
    expect(devRule.params.internalSecret).toBeUndefined();
    expect(devRule.createdBy).toBeUndefined();
    // Fields R-184 `/explain rule <id>` actually needs are still present.
    expect(devRule.id).toEqual(expect.any(String));
    expect(devRule.kind).toBe('min_output_summary_chars');
    expect(devRule.scope).toBe('project');
    expect(devRule.enabled).toBe(true);

    // Agent (exec-time caller): same sanitisation applies.
    const agentRes = await listRulesGet(
      makeReq(`/api/projects/${projectId}/verification-rules`, {
        method: 'GET',
        userName: agentName,
      }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(agentRes.status).toBe(200);
    const agentJson = await agentRes.json();
    expect(agentJson.data[0].params).toEqual({ min: 100 });
    expect(agentJson.data[0].params.internalSecret).toBeUndefined();
    expect(agentJson.data[0].createdBy).toBeUndefined();
  });

  // #2830: for rule kinds whose evaluator reads no params at all (e.g.
  // `require_files_changed`), the public projection must return `{}` for
  // `params` no matter what arbitrary keys an owner has written into the
  // JSONB column. This is what prevents a `kind: 'require_files_changed'`
  // rule from being abused as a generic owner-writable-string broadcast
  // channel to non-owner members and exec sessions.
  it('#2830: non-owner GET returns empty params for kinds whose evaluator reads no params', async () => {
    await testPrisma.verificationRule.create({
      data: {
        projectId,
        kind: 'require_files_changed',
        scope: 'project',
        // The evaluator ignores params for this kind, but the column is
        // still owner-writable JSONB. A non-owner / exec caller must not
        // see any of these keys.
        params: { internalSecret: 's3cret-do-not-leak', filePath: '/etc/passwd' },
        enabled: true,
        createdBy: owner,
      },
    });

    const devRes = await listRulesGet(
      makeReq(`/api/projects/${projectId}/verification-rules`, {
        method: 'GET',
        userName: developer,
      }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(devRes.status).toBe(200);
    const devJson = await devRes.json();
    expect(devJson.data).toHaveLength(1);
    expect(devJson.data[0].params).toEqual({});
    expect(devJson.data[0].createdBy).toBeUndefined();
  });

  // #1452 + #2830: closes the hole left open in PR #1447 — projectRole ===
  // 'owner' alone is not enough trust for the raw row. An owner-issued
  // exec-scoped token (the kind /exec / /worker hand to a Genie sub-agent)
  // must be treated like any other exec caller and receive only the public
  // projection (allowlisted params, no createdBy). Otherwise a compromised
  // exec session keeps reading owner-only JSONB.
  it('#1452 + #2830: owner-issued exec-scoped token gets allowlisted params, no createdBy', async () => {
    await testPrisma.verificationRule.create({
      data: {
        projectId,
        kind: 'min_output_summary_chars',
        scope: 'project',
        params: { min: 100, internalSecret: 's3cret-do-not-leak' },
        enabled: true,
        createdBy: owner,
      },
    });

    // Mint an exec-scoped API key for the owner via the same path
    // /exec-sessions/issue-token uses in production. The key carries
    // both (projectId, execRunId) so requireProjectRole accepts it for
    // this project but auth.execRunId is set.
    const { POST: issueTokenPost } = await import('@/app/api/exec-sessions/issue-token/route');
    const ownerRun = await testPrisma.executionRun.create({
      data: {
        taskId,
        status: 'running',
        executorType: 'human',
        executorName: owner,
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(),
      },
    });
    const issueRes = await issueTokenPost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        body: { runId: ownerRun.id, taskId, projectId },
      }),
    );
    expect(issueRes.status).toBe(201);
    const issued = await issueRes.json();
    const ownerExecKey = issued.data.key as string;
    expect(ownerExecKey).toMatch(/^ps_key_exec_/);

    const ownerExecRes = await listRulesGet(
      makeReq(`/api/projects/${projectId}/verification-rules`, {
        method: 'GET',
        userName: owner,
        authToken: ownerExecKey,
      }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(ownerExecRes.status).toBe(200);
    const ownerExecJson = await ownerExecRes.json();
    expect(ownerExecJson.data).toHaveLength(1);
    // Even though the underlying user is the project owner, the exec
    // session must see the same sanitised projection a non-owner agent
    // would get — only the allowlisted `min` leaks through, and the
    // owner-written `internalSecret` JSONB key stays server-side.
    expect(ownerExecJson.data[0].params).toEqual({ min: 100 });
    expect(ownerExecJson.data[0].params.internalSecret).toBeUndefined();
    expect(ownerExecJson.data[0].createdBy).toBeUndefined();
    expect(ownerExecJson.data[0].kind).toBe('min_output_summary_chars');
  });

  it('#1220: a non-member of the project still gets 403 on GET (membership gate stays on)', async () => {
    const stranger = 'r181-stranger';
    const res = await listRulesGet(
      makeReq(`/api/projects/${projectId}/verification-rules`, {
        method: 'GET',
        userName: stranger,
      }),
      { params: Promise.resolve({ projectId }) },
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
      { params: Promise.resolve({ projectId }) },
    );
    expect(res.status).toBe(400);
  });
});

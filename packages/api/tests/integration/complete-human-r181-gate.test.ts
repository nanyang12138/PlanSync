// Regression: complete-human must honor R-181 declarative verification rules,
// mirroring the agent completion path (runs/[runId]/route.ts:291). Before the
// fix, an owner-configured HARD gate (require_pr_merged, require_files_changed,
// ...) was enforced for agent completions yet trivially bypassed by a human
// clicking "complete". The human endpoint carries outputSummary (= the
// completion note), deliverablesMet (= the task's plan-deliverable refs) and an
// optional prUrl, so rules over those signals apply directly. Rules that demand
// evidence the manual endpoint cannot supply (require_files_changed /
// require_commits_on_branch) fail closed BY DESIGN.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { POST as completeHumanPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/complete-human/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('complete-human R-181 verification-rule gate', () => {
  const owner = 'ch-r181-owner';
  let projectId: string;
  let planVersion: number;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    ({ version: planVersion } = await createActivePlan(projectId, owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  beforeEach(async () => {
    await testPrisma.verificationRule.deleteMany({ where: { projectId } });
    await testPrisma.executionRun.deleteMany({ where: { task: { projectId } } });
    await testPrisma.task.deleteMany({ where: { projectId } });
  });

  async function makeTask() {
    return testPrisma.task.create({
      data: {
        projectId,
        title: 'Human task',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: owner,
        assigneeType: 'human',
        boundPlanVersion: planVersion,
        agentConstraints: [],
      },
    });
  }

  function complete(taskId: string, completionNote: string) {
    return completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/complete-human`, {
        method: 'POST',
        userName: owner,
        body: { completionNote },
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );
  }

  it('422s with the rule-gate envelope when a min_output_summary_chars rule is unmet', async () => {
    await testPrisma.verificationRule.create({
      data: {
        projectId,
        kind: 'min_output_summary_chars',
        scope: 'project',
        enabled: true,
        params: { min: 50 },
        createdBy: owner,
      },
    });
    const task = await makeTask();
    const res = await complete(task.id, 'too short');

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('VERIFICATION_RULE_FAILED');
    expect(body.error.gate).toBe('rule');
    expect(body.error.details.failedRules[0].kind).toBe('min_output_summary_chars');

    // No side effects: the task must not be done and no run row written.
    const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(refreshed?.status).toBe('in_progress');
    expect(await testPrisma.executionRun.count({ where: { taskId: task.id } })).toBe(0);
  });

  it('completes when the min_output_summary_chars rule is satisfied', async () => {
    await testPrisma.verificationRule.create({
      data: {
        projectId,
        kind: 'min_output_summary_chars',
        scope: 'project',
        enabled: true,
        params: { min: 10 },
        createdBy: owner,
      },
    });
    const task = await makeTask();
    const res = await complete(task.id, 'this note is definitely long enough to pass the rule');

    expect(res.status).toBe(200);
    const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(refreshed?.status).toBe('done');
  });

  it('422s on require_files_changed — manual completion cannot supply file evidence (fail-closed by design)', async () => {
    await testPrisma.verificationRule.create({
      data: {
        projectId,
        kind: 'require_files_changed',
        scope: 'project',
        enabled: true,
        createdBy: owner,
      },
    });
    const task = await makeTask();
    const res = await complete(task.id, 'note is long but the endpoint carries no filesChanged');

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('VERIFICATION_RULE_FAILED');
    expect(body.error.details.failedRules.map((r: { kind: string }) => r.kind)).toContain(
      'require_files_changed',
    );
  });

  it('is a no-op when the project has no verification rules (legacy path preserved)', async () => {
    const task = await makeTask();
    const res = await complete(task.id, 'no rules configured, should just complete');

    expect(res.status).toBe(200);
    const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(refreshed?.status).toBe('done');
  });
});

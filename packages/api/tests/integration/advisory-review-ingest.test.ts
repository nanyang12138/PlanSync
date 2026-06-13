/**
 * PR1 (advisory-review-ingest): the `complete` path accepts an OPTIONAL bag of
 * structured code-review advisories from the exec environment, stores each as a
 * `RunReview { kind: 'code_review_advisory' }` row, and echoes a summary —
 * WITHOUT ever blocking completion. The completion-state explainer then
 * surfaces the latest advisory for the owner's decision point.
 *
 * The load-bearing invariant pinned here is "always advisory": a malformed
 * `advisoryReviews` payload must NOT turn `complete` into a 400/422. The run
 * still finalizes; the bad advisory is dropped into `advisoryReviewWarnings`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { POST as runPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/[runId]/route';
import { GET as completionStateGet } from '@/app/api/projects/[projectId]/tasks/[taskId]/completion-state/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

const owner = 'adv-owner';
let projectId: string;
let planVersion: number;

beforeAll(async () => {
  ({ projectId } = await createTestProject(owner));
  const { version } = await createActivePlan(projectId, owner);
  planVersion = version;
});

afterAll(async () => {
  await cleanupProject(projectId);
});

beforeEach(async () => {
  await testPrisma.runReview.deleteMany({ where: { run: { task: { projectId } } } });
  await testPrisma.executionRun.deleteMany({ where: { task: { projectId } } });
  await testPrisma.task.deleteMany({ where: { projectId } });
});

// A human-executed task + running run. Human executor skips the agent
// AI-verify branch, isolating the advisory-review ingest under test. The
// project has no git wiring → the R-192 gate lets the task flip to `done`.
async function makeRunningTask() {
  const task = await testPrisma.task.create({
    data: {
      projectId,
      title: 'advisory task',
      type: 'code',
      priority: 'p1',
      status: 'in_progress',
      assignee: owner,
      assigneeType: 'human',
      boundPlanVersion: planVersion,
      agentConstraints: [],
    },
  });
  const run = await testPrisma.executionRun.create({
    data: {
      taskId: task.id,
      executorType: 'human',
      executorName: owner,
      boundPlanVersion: planVersion,
      status: 'running',
      taskPackSnapshot: {},
      lastHeartbeatAt: new Date(),
      filesChanged: [],
      blockers: [],
      driftSignals: [],
    },
  });
  return { taskId: task.id, runId: run.id };
}

async function complete(taskId: string, runId: string, advisoryReviews: unknown) {
  const res = await runPost(
    makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}`, {
      method: 'POST',
      userName: owner,
      searchParams: { action: 'complete' },
      body: {
        status: 'completed',
        deliverablesMet: ['did the thing'],
        outputSummary: 'work done',
        advisoryReviews,
      },
    }),
    { params: Promise.resolve({ projectId, taskId, runId }) },
  );
  return { res, body: await res.json() };
}

async function getState(taskId: string) {
  const res = await completionStateGet(
    makeReq(`/api/projects/${projectId}/tasks/${taskId}/completion-state`, { userName: owner }),
    { params: Promise.resolve({ projectId, taskId }) },
  );
  return { res, body: await res.json() };
}

const oneReview = [
  {
    kind: 'code_review_advisory',
    source: 'exec_agent',
    reviewedRef: { branchName: 'feat/x', headSha: 'abc123', baseSha: 'def456' },
    summary: 'No blocker. 1 medium around test coverage.',
    findings: [
      { severity: 'medium', file: 'a.ts', line: 88, message: 'missing test', confidence: 0.72 },
      { severity: 'low', file: 'b.ts', message: 'nit' },
    ],
  },
];

describe('advisory-review ingest on complete', () => {
  it('stores a submitted advisory and echoes a summary', async () => {
    const { taskId, runId } = await makeRunningTask();
    const { res, body } = await complete(taskId, runId, oneReview);

    expect(res.status).toBe(200);
    expect(body.advisoryReviews).toHaveLength(1);
    expect(body.advisoryReviews[0].findingCount).toBe(2);
    expect(body.advisoryReviews[0].counts.medium).toBe(1);
    expect(body.advisoryReviews[0].source).toBe('exec_agent');
    expect(body.advisoryReviews[0].truncated).toBe(false);
    expect(body.advisoryReviewWarnings).toBeUndefined();

    // RunReview row persisted with structured findings in metadata.
    const rows = await testPrisma.runReview.findMany({
      where: { runId, kind: 'code_review_advisory' },
    });
    expect(rows).toHaveLength(1);
    const meta = rows[0].metadata as Record<string, unknown>;
    expect((meta.findings as unknown[]).length).toBe(2);
    expect(meta.source).toBe('exec_agent');

    // The run still completed (advisory never blocks).
    const run = await testPrisma.executionRun.findUnique({ where: { id: runId } });
    expect(run?.status).toBe('completed');
    // Non-git project → task done.
    const task = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('done');
  });

  it('completes normally when no advisoryReviews are sent (legacy shape preserved)', async () => {
    const { taskId, runId } = await makeRunningTask();
    const { res, body } = await complete(taskId, runId, undefined);
    expect(res.status).toBe(200);
    expect(body.advisoryReviews).toBeUndefined();
    expect(body.advisoryReviewWarnings).toBeUndefined();
    const run = await testPrisma.executionRun.findUnique({ where: { id: runId } });
    expect(run?.status).toBe('completed');
  });

  it('NEVER blocks completion on a malformed advisoryReviews payload', async () => {
    const { taskId, runId } = await makeRunningTask();
    // A string where an array is expected — the worst-case garbage.
    const { res, body } = await complete(taskId, runId, 'totally not an array');

    expect(res.status).toBe(200); // not 400, not 422
    expect(body.advisoryReviews).toBeUndefined();
    expect(body.advisoryReviewWarnings.join(' ')).toMatch(/not an array/i);

    const run = await testPrisma.executionRun.findUnique({ where: { id: runId } });
    expect(run?.status).toBe('completed');
    const rows = await testPrisma.runReview.findMany({
      where: { runId, kind: 'code_review_advisory' },
    });
    expect(rows).toHaveLength(0);
  });

  it('drops an invalid finding but keeps the rest, still 200', async () => {
    const { taskId, runId } = await makeRunningTask();
    const mixed = [
      {
        kind: 'code_review_advisory',
        source: 'exec_agent',
        findings: [
          { severity: 'high', file: 'a.ts', message: 'real bug' },
          { severity: 'high', file: 'b.ts' }, // missing message → dropped
        ],
      },
    ];
    const { res, body } = await complete(taskId, runId, mixed);

    expect(res.status).toBe(200);
    expect(body.advisoryReviews[0].findingCount).toBe(1);
    expect(body.advisoryReviews[0].counts.high).toBe(1);
    expect(body.advisoryReviewWarnings.join(' ')).toMatch(/invalid/i);
  });

  it('completion-state surfaces the latest advisory with fromLatestRun', async () => {
    const { taskId, runId } = await makeRunningTask();
    await complete(taskId, runId, oneReview);

    const { res, body } = await getState(taskId);
    expect(res.status).toBe(200);
    expect(body.data.latestAdvisoryReview).not.toBeNull();
    expect(body.data.latestAdvisoryReview.runId).toBe(runId);
    expect(body.data.latestAdvisoryReview.fromLatestRun).toBe(true);
    expect(body.data.latestAdvisoryReview.counts.medium).toBe(1);
    expect(body.data.latestAdvisoryReview.source).toBe('exec_agent');
  });

  it('marks an advisory fromLatestRun=false once a newer run exists', async () => {
    const { taskId, runId } = await makeRunningTask();
    await complete(taskId, runId, oneReview);

    // A second, later run for the same task (no advisory of its own).
    const newer = await testPrisma.executionRun.create({
      data: {
        taskId,
        executorType: 'human',
        executorName: owner,
        boundPlanVersion: planVersion,
        status: 'running',
        taskPackSnapshot: {},
        lastHeartbeatAt: new Date(),
        filesChanged: [],
        blockers: [],
        driftSignals: [],
      },
    });
    await complete(taskId, newer.id, undefined);

    const { body } = await getState(taskId);
    // Latest advisory is still the one from the first run, now flagged stale.
    expect(body.data.latestAdvisoryReview.runId).toBe(runId);
    expect(body.data.latestAdvisoryReview.fromLatestRun).toBe(false);
  });
});

// R-108: heartbeat-scanner stale/failed 写 activity
//
// `scanStaleExecutions` is the only place an ExecutionRun flips from
// `running` to `stale` (5-min heartbeat timeout) or from `stale` to
// `failed` (30-min heartbeat timeout). Before R-108 both transitions
// were invisible to the activity feed — the owner saw
// `execution_started` and then the run silently disappeared from the
// active board, leaving no audit trail of *who* abandoned the work or
// *when*. R-104/R-105/R-106/R-107 closed equivalent gaps for plan
// PATCH, task PATCH/DELETE, and drift cancel; R-108 closes it for the
// scanner.
//
// This test asserts:
//   1. A `running` run with `lastHeartbeatAt` older than 5min flips to
//      `stale` AND writes an `execution_stale` activity whose summary
//      mentions the task title and whose metadata captures runId,
//      taskId, executor, the actual threshold used, last heartbeat,
//      and the R-057 side effects (taskBlocked, execKeysRevoked). The
//      actor is `system`.
//   2. A `stale` run with `lastHeartbeatAt` older than 30min flips to
//      `failed` AND writes an `execution_failed` activity with the
//      corresponding metadata.
//   3. A fresh `running` run with a recent heartbeat is left alone and
//      writes no activity — the scanner only audits actual flips.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { scanStaleExecutions } from '@/lib/heartbeat-scanner';
import { createTestProject, cleanupProject, testPrisma } from '../helpers/request';

describe('R-108: heartbeat scanner writes execution_stale / execution_failed activity', () => {
  const owner = 'r108-owner';
  let projectId: string;
  let planVersion: number;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const plan = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'R108 Plan',
        goal: 'goal',
        scope: 'scope',
        version: 1,
        status: 'active',
        createdBy: owner,
        activatedAt: new Date(),
        activatedBy: owner,
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
      },
    });
    planVersion = plan.version;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  async function createTaskWithRun(opts: {
    title: string;
    status: 'running' | 'stale';
    heartbeatAgeMs: number;
    taskStatus?: string;
  }) {
    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: opts.title,
        type: 'code',
        priority: 'p2',
        status: opts.taskStatus ?? 'in_progress',
        assigneeType: 'agent',
        assignee: 'agent-x',
        boundPlanVersion: planVersion,
        agentConstraints: [],
      },
    });
    const heartbeatAt = new Date(Date.now() - opts.heartbeatAgeMs);
    const run = await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
        executorType: 'agent',
        executorName: 'agent-x',
        status: opts.status,
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: heartbeatAt,
        lastHeartbeatAt: heartbeatAt,
      },
    });
    return { taskId: task.id, runId: run.id };
  }

  it('flips running → stale after 5min and writes execution_stale activity', async () => {
    const title = `R108 stale ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { taskId, runId } = await createTaskWithRun({
      title,
      status: 'running',
      heartbeatAgeMs: 6 * 60 * 1000,
    });

    const beforeStale = await testPrisma.activity.count({
      where: { projectId, type: 'execution_stale' },
    });

    await scanStaleExecutions();

    const run = await testPrisma.executionRun.findUnique({ where: { id: runId } });
    expect(run?.status).toBe('stale');

    const afterStale = await testPrisma.activity.findMany({
      where: { projectId, type: 'execution_stale' },
      orderBy: { createdAt: 'desc' },
    });
    expect(afterStale.length).toBe(beforeStale + 1);

    const activity = afterStale[0];
    expect(activity.actorName).toBe('system');
    expect(activity.actorType).toBe('system');
    expect(activity.summary).toContain(title);
    expect(activity.summary.toLowerCase()).toContain('stale');

    const md = activity.metadata as {
      runId?: string;
      taskId?: string;
      executorName?: string;
      reason?: string;
      thresholdMs?: number;
      taskBlocked?: boolean;
      execKeysRevoked?: number;
      lastHeartbeatAt?: string | null;
    } | null;
    expect(md?.runId).toBe(runId);
    expect(md?.taskId).toBe(taskId);
    expect(md?.executorName).toBe('agent-x');
    expect(md?.reason).toBe('heartbeat_timeout_stale');
    expect(md?.thresholdMs).toBe(5 * 60 * 1000);
    expect(md?.taskBlocked).toBe(true);
    expect(md?.execKeysRevoked).toBe(0);
    expect(typeof md?.lastHeartbeatAt).toBe('string');

    // R-057 side effect: task should now be blocked
    const task = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('blocked');
  });

  it('flips stale → failed after 30min and writes execution_failed activity', async () => {
    const title = `R108 failed ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { taskId, runId } = await createTaskWithRun({
      title,
      status: 'stale',
      heartbeatAgeMs: 31 * 60 * 1000,
      taskStatus: 'blocked',
    });

    const beforeFailed = await testPrisma.activity.count({
      where: { projectId, type: 'execution_failed' },
    });

    await scanStaleExecutions();

    const run = await testPrisma.executionRun.findUnique({ where: { id: runId } });
    expect(run?.status).toBe('failed');
    expect(run?.endedAt).not.toBeNull();

    const afterFailed = await testPrisma.activity.findMany({
      where: { projectId, type: 'execution_failed' },
      orderBy: { createdAt: 'desc' },
    });
    expect(afterFailed.length).toBe(beforeFailed + 1);

    const activity = afterFailed[0];
    expect(activity.actorName).toBe('system');
    expect(activity.actorType).toBe('system');
    expect(activity.summary).toContain(title);
    expect(activity.summary.toLowerCase()).toContain('failed');

    const md = activity.metadata as {
      runId?: string;
      taskId?: string;
      executorName?: string;
      reason?: string;
      thresholdMs?: number;
      lastHeartbeatAt?: string | null;
    } | null;
    expect(md?.runId).toBe(runId);
    expect(md?.taskId).toBe(taskId);
    expect(md?.executorName).toBe('agent-x');
    expect(md?.reason).toBe('heartbeat_timeout_failed');
    expect(md?.thresholdMs).toBe(30 * 60 * 1000);
    expect(typeof md?.lastHeartbeatAt).toBe('string');
  });

  it('fresh running run writes no activity and is left running', async () => {
    const title = `R108 fresh ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { runId } = await createTaskWithRun({
      title,
      status: 'running',
      heartbeatAgeMs: 30 * 1000,
    });

    const beforeStale = await testPrisma.activity.count({
      where: { projectId, type: 'execution_stale' },
    });
    const beforeFailed = await testPrisma.activity.count({
      where: { projectId, type: 'execution_failed' },
    });

    await scanStaleExecutions();

    const run = await testPrisma.executionRun.findUnique({ where: { id: runId } });
    expect(run?.status).toBe('running');

    const afterStale = await testPrisma.activity.count({
      where: { projectId, type: 'execution_stale' },
    });
    const afterFailed = await testPrisma.activity.count({
      where: { projectId, type: 'execution_failed' },
    });
    expect(afterStale).toBe(beforeStale);
    expect(afterFailed).toBe(beforeFailed);
  });
});

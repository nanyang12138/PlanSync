// R-004: rebind semantics upgraded to "explicit restart".
//
// Before this change, resolving a drift via `rebind` (either through
// `POST /drifts/:id` or the standalone `POST /tasks/:id/rebind`) only:
//   1. updated `task.boundPlanVersion` to the active plan version
//   2. for a *blocked* task, flipped status back to `in_progress`
// It did NOT mark any running/paused ExecutionRun as `superseded`, and
// it left an `in_progress` task in `in_progress` even though the agent
// that previously owned the run had already had its tool stream aborted
// (R-002 / R-005). The task and the dead run were in a torn state.
//
// New semantics: rebind means "this task starts over against the new
// plan". So:
//   - non-terminal task status → reset to `todo` (a fresh
//     `execution_start` is the only way to resume work)
//   - all paused/running runs → moved to `superseded` with `endedAt` set
//   - terminal task states (`done`, `cancelled`) are preserved — the
//     version reference moves but the lifecycle stays terminal
//
// This file covers both entry points and verifies that a freshly
// rebound task can immediately start a new execution.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST as driftPost } from '@/app/api/projects/[projectId]/drifts/[driftId]/route';
import { POST as taskRebindPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/rebind/route';
import { POST as runsPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/route';
import { makeReq, createTestProject, cleanupProject, testPrisma } from '../helpers/request';

const owner = 'r004-owner';

async function setupProjectWithV2() {
  const { projectId } = await createTestProject(owner);
  await testPrisma.projectMember.upsert({
    where: { projectId_name: { projectId, name: 'r004-agent' } },
    update: {},
    create: { projectId, name: 'r004-agent', role: 'developer', type: 'agent' },
  });
  // v1 (superseded) + v2 (active). R-048 partial unique index requires
  // any prior active row to be moved first, so we create v1 directly as
  // `superseded` to keep this setup linear.
  await testPrisma.plan.create({
    data: {
      projectId,
      title: 'V1',
      goal: 'v1 goal',
      scope: 'v1 scope',
      version: 1,
      status: 'superseded',
      createdBy: owner,
      constraints: [],
      standards: [],
      deliverables: [],
      openQuestions: [],
      requiredReviewers: [],
    },
  });
  const v2 = await testPrisma.plan.create({
    data: {
      projectId,
      title: 'V2',
      goal: 'v2 goal',
      scope: 'v2 scope',
      version: 2,
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
  return { projectId, activeVersion: v2.version };
}

async function createTaskBoundToV1(
  projectId: string,
  status: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled',
  opts?: { withRunningRun?: boolean; assignee?: string },
) {
  const task = await testPrisma.task.create({
    data: {
      projectId,
      title: `R-004 task (${status})`,
      type: 'code',
      priority: 'p1',
      status,
      assignee: opts?.assignee,
      assigneeType: opts?.assignee ? 'agent' : 'unassigned',
      boundPlanVersion: 1,
      agentConstraints: [],
    },
  });
  let runId: string | undefined;
  if (opts?.withRunningRun) {
    const run = await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
        executorType: 'agent',
        executorName: opts.assignee ?? 'r004-agent',
        status: 'running',
        boundPlanVersion: 1,
        taskPackSnapshot: {},
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    });
    runId = run.id;
  }
  return { taskId: task.id, runId };
}

async function createOpenDrift(projectId: string, taskId: string) {
  const alert = await testPrisma.driftAlert.create({
    data: {
      projectId,
      taskId,
      type: 'version_mismatch',
      severity: 'high',
      reason: 'R-004 test drift',
      status: 'open',
      currentPlanVersion: 2,
      taskBoundVersion: 1,
    },
  });
  return alert.id;
}

describe('R-004: rebind is an explicit restart', () => {
  let projectId: string;

  beforeEach(async () => {
    ({ projectId } = await setupProjectWithV2());
  });

  afterEach(async () => {
    await cleanupProject(projectId);
  });

  it('drifts/:id rebind resets an in_progress task to todo and supersedes its running run', async () => {
    const { taskId, runId } = await createTaskBoundToV1(projectId, 'in_progress', {
      withRunningRun: true,
      assignee: 'r004-agent',
    });
    const driftId = await createOpenDrift(projectId, taskId);

    const res = await driftPost(
      makeReq(`/api/projects/${projectId}/drifts/${driftId}`, {
        method: 'POST',
        userName: owner,
        body: { action: 'rebind' },
      }),
      { params: { projectId, driftId } },
    );
    expect(res.status).toBe(200);

    const updatedTask = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(updatedTask?.status).toBe('todo');
    expect(updatedTask?.boundPlanVersion).toBe(2);

    const updatedRun = await testPrisma.executionRun.findUnique({ where: { id: runId! } });
    expect(updatedRun?.status).toBe('superseded');
    expect(updatedRun?.endedAt).not.toBeNull();

    const alert = await testPrisma.driftAlert.findUnique({ where: { id: driftId } });
    expect(alert?.status).toBe('resolved');
    expect(alert?.resolvedAction).toBe('rebind');
  });

  it('drifts/:id rebind also resets a blocked task to todo (not in_progress)', async () => {
    const { taskId } = await createTaskBoundToV1(projectId, 'blocked');
    const driftId = await createOpenDrift(projectId, taskId);

    const res = await driftPost(
      makeReq(`/api/projects/${projectId}/drifts/${driftId}`, {
        method: 'POST',
        userName: owner,
        body: { action: 'rebind' },
      }),
      { params: { projectId, driftId } },
    );
    expect(res.status).toBe(200);

    const updatedTask = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(updatedTask?.status).toBe('todo');
    expect(updatedTask?.boundPlanVersion).toBe(2);
  });

  it('drifts/:id rebind preserves terminal status (done) — only version reference moves', async () => {
    const { taskId } = await createTaskBoundToV1(projectId, 'done');
    const driftId = await createOpenDrift(projectId, taskId);

    const res = await driftPost(
      makeReq(`/api/projects/${projectId}/drifts/${driftId}`, {
        method: 'POST',
        userName: owner,
        body: { action: 'rebind' },
      }),
      { params: { projectId, driftId } },
    );
    expect(res.status).toBe(200);

    const updatedTask = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(updatedTask?.status).toBe('done');
    expect(updatedTask?.boundPlanVersion).toBe(2);
  });

  it('tasks/:id/rebind resets in_progress → todo and supersedes paused/running runs', async () => {
    const { taskId, runId } = await createTaskBoundToV1(projectId, 'in_progress', {
      withRunningRun: true,
      assignee: 'r004-agent',
    });
    // Also create a paused run to ensure both lifecycles are swept.
    const pausedRun = await testPrisma.executionRun.create({
      data: {
        taskId,
        executorType: 'agent',
        executorName: 'r004-agent',
        status: 'paused',
        boundPlanVersion: 1,
        taskPackSnapshot: {},
        startedAt: new Date(Date.now() - 60_000),
        lastHeartbeatAt: new Date(Date.now() - 60_000),
      },
    });

    const res = await taskRebindPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/rebind`, {
        method: 'POST',
        userName: owner,
      }),
      { params: { projectId, taskId } },
    );
    expect(res.status).toBe(200);

    const updatedTask = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(updatedTask?.status).toBe('todo');
    expect(updatedTask?.boundPlanVersion).toBe(2);

    const runningSwept = await testPrisma.executionRun.findUnique({ where: { id: runId! } });
    expect(runningSwept?.status).toBe('superseded');
    expect(runningSwept?.endedAt).not.toBeNull();

    const pausedSwept = await testPrisma.executionRun.findUnique({
      where: { id: pausedRun.id },
    });
    expect(pausedSwept?.status).toBe('superseded');
    expect(pausedSwept?.endedAt).not.toBeNull();
  });

  it('after rebind, a fresh execution_start succeeds immediately (not stuck blocked)', async () => {
    const { taskId } = await createTaskBoundToV1(projectId, 'in_progress', {
      withRunningRun: true,
      assignee: 'r004-agent',
    });
    const driftId = await createOpenDrift(projectId, taskId);

    const rebindRes = await driftPost(
      makeReq(`/api/projects/${projectId}/drifts/${driftId}`, {
        method: 'POST',
        userName: owner,
        body: { action: 'rebind' },
      }),
      { params: { projectId, driftId } },
    );
    expect(rebindRes.status).toBe(200);

    const startRes = await runsPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs`, {
        method: 'POST',
        userName: owner,
        body: { executorType: 'agent', executorName: 'r004-agent' },
      }),
      { params: { projectId, taskId } },
    );
    expect(startRes.status).toBe(201);
    const newRun = (await startRes.json()).data as {
      id: string;
      status: string;
      boundPlanVersion: number;
    };
    expect(newRun.status).toBe('running');
    expect(newRun.boundPlanVersion).toBe(2);

    const taskAfter = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(taskAfter?.status).toBe('in_progress');
  });
});

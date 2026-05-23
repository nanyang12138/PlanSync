// R-107: drift cancel action 写 activity
//
// `POST /projects/:projectId/drifts/:driftId` with `action: 'cancel'`
// is the only drift-resolution path that terminates the task
// (moves Task.status to 'cancelled' and supersedes any live run).
// The route already writes a generic `drift_resolved` activity, but
// that row only captures *how the drift was answered*, not *what
// happened to the task*. Without a dedicated `task_cancelled` row
// the activity feed has the same audit gap R-105 and R-106 closed
// for task PATCH/DELETE — an owner reading the feed sees the drift
// acknowledgement and a task that quietly vanished from the active
// board.
//
// This test asserts:
//   1. `action: 'cancel'` writes BOTH `drift_resolved` and a paired
//      `task_cancelled` activity, and the `task_cancelled` row
//      captures the pre-cancel snapshot (taskId, title, previous
//      status, driftId, reason='drift_cancel') and the caller as
//      actor.
//   2. `action: 'no_impact'` writes ONLY `drift_resolved` — adding
//      `task_cancelled` here would be a lie because the task is
//      not terminated.
//   3. `action: 'rebind'` writes ONLY `drift_resolved` — rebind
//      restarts the task on the new plan version, it does not
//      cancel.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as driftPost } from '@/app/api/projects/[projectId]/drifts/[driftId]/route';
import { makeReq, createTestProject, cleanupProject, testPrisma } from '../helpers/request';

describe('R-107: drift cancel action writes task_cancelled activity', () => {
  const owner = 'r107-owner';
  let projectId: string;
  let planV1Version: number;
  let planV2Version: number;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));

    const v1 = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'R107 Plan v1',
        goal: 'goal v1',
        scope: 'scope v1',
        version: 1,
        status: 'superseded',
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
    planV1Version = v1.version;

    const v2 = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'R107 Plan v2',
        goal: 'goal v2',
        scope: 'scope v2',
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
    planV2Version = v2.version;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  async function createTaskWithDrift(opts: {
    title: string;
    status?: string;
  }): Promise<{ taskId: string; driftId: string }> {
    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: opts.title,
        type: 'code',
        priority: 'p2',
        status: opts.status ?? 'todo',
        assigneeType: 'unassigned',
        boundPlanVersion: planV1Version,
        agentConstraints: [],
      },
    });
    const drift = await testPrisma.driftAlert.create({
      data: {
        projectId,
        taskId: task.id,
        type: 'version_mismatch',
        severity: 'medium',
        reason: 'test cancel path',
        status: 'open',
        currentPlanVersion: planV2Version,
        taskBoundVersion: planV1Version,
      },
    });
    return { taskId: task.id, driftId: drift.id };
  }

  it('action=cancel writes a paired task_cancelled activity with pre-cancel snapshot', async () => {
    const title = `R107 cancel ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { taskId, driftId } = await createTaskWithDrift({
      title,
      status: 'in_progress',
    });

    const beforeCancelled = await testPrisma.activity.count({
      where: { projectId, type: 'task_cancelled' },
    });
    const beforeResolved = await testPrisma.activity.count({
      where: { projectId, type: 'drift_resolved' },
    });

    const res = await driftPost(
      makeReq(`/api/projects/${projectId}/drifts/${driftId}`, {
        method: 'POST',
        userName: owner,
        body: { action: 'cancel' },
      }),
      { params: { projectId, driftId } },
    );
    expect(res.status).toBe(200);

    const afterCancelled = await testPrisma.activity.findMany({
      where: { projectId, type: 'task_cancelled' },
      orderBy: { createdAt: 'desc' },
    });
    const afterResolved = await testPrisma.activity.count({
      where: { projectId, type: 'drift_resolved' },
    });

    expect(afterCancelled.length).toBe(beforeCancelled + 1);
    expect(afterResolved).toBe(beforeResolved + 1);

    const activity = afterCancelled[0];
    expect(activity.actorName).toBe(owner);
    expect(activity.actorType).toBe('human');
    expect(activity.summary).toContain(title);
    expect(activity.summary.toLowerCase()).toContain('cancel');

    const md = activity.metadata as {
      taskId?: string;
      title?: string;
      previousStatus?: string;
      driftId?: string;
      reason?: string;
    } | null;
    expect(md?.taskId).toBe(taskId);
    expect(md?.title).toBe(title);
    expect(md?.previousStatus).toBe('in_progress');
    expect(md?.driftId).toBe(driftId);
    expect(md?.reason).toBe('drift_cancel');

    const task = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('cancelled');
  });

  it('action=no_impact writes drift_resolved only, no task_cancelled', async () => {
    const title = `R107 no_impact ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { taskId, driftId } = await createTaskWithDrift({ title });

    const beforeCancelled = await testPrisma.activity.count({
      where: { projectId, type: 'task_cancelled' },
    });
    const beforeResolved = await testPrisma.activity.count({
      where: { projectId, type: 'drift_resolved' },
    });

    const res = await driftPost(
      makeReq(`/api/projects/${projectId}/drifts/${driftId}`, {
        method: 'POST',
        userName: owner,
        body: { action: 'no_impact' },
      }),
      { params: { projectId, driftId } },
    );
    expect(res.status).toBe(200);

    const afterCancelled = await testPrisma.activity.count({
      where: { projectId, type: 'task_cancelled' },
    });
    const afterResolved = await testPrisma.activity.count({
      where: { projectId, type: 'drift_resolved' },
    });

    expect(afterCancelled).toBe(beforeCancelled);
    expect(afterResolved).toBe(beforeResolved + 1);

    const task = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(task?.status).not.toBe('cancelled');
  });

  it('action=rebind writes drift_resolved only, no task_cancelled', async () => {
    const title = `R107 rebind ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { taskId, driftId } = await createTaskWithDrift({ title });

    const beforeCancelled = await testPrisma.activity.count({
      where: { projectId, type: 'task_cancelled' },
    });
    const beforeResolved = await testPrisma.activity.count({
      where: { projectId, type: 'drift_resolved' },
    });

    const res = await driftPost(
      makeReq(`/api/projects/${projectId}/drifts/${driftId}`, {
        method: 'POST',
        userName: owner,
        body: { action: 'rebind' },
      }),
      { params: { projectId, driftId } },
    );
    expect(res.status).toBe(200);

    const afterCancelled = await testPrisma.activity.count({
      where: { projectId, type: 'task_cancelled' },
    });
    const afterResolved = await testPrisma.activity.count({
      where: { projectId, type: 'drift_resolved' },
    });

    expect(afterCancelled).toBe(beforeCancelled);
    expect(afterResolved).toBe(beforeResolved + 1);

    const task = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(task?.status).not.toBe('cancelled');
    expect(task?.boundPlanVersion).toBe(planV2Version);
  });
});

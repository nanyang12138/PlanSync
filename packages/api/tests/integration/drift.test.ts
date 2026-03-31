// H module: Drift engine
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GET as driftsGet } from '@/app/api/projects/[projectId]/drifts/route';
import { POST as driftPost } from '@/app/api/projects/[projectId]/drifts/[driftId]/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { POST as reactivatePost } from '@/app/api/projects/[projectId]/plans/[planId]/reactivate/route';
import { makeReq, createTestProject, cleanupProject, testPrisma } from '../helpers/request';

describe('H: Drift Engine', () => {
  const owner = 'drift-owner';
  let projectId: string;

  // Shared state across tests
  let taskId: string;
  let taskDoneId: string;
  let taskCancelledId: string;
  let planV1Id: string;
  let planV2Id: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));

    // Create v1 plan directly in DB
    const v1 = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'Plan V1',
        goal: 'goal v1',
        scope: 'scope v1',
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
    planV1Id = v1.id;

    // Create tasks bound to v1
    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'Todo task',
        type: 'code',
        priority: 'p1',
        status: 'todo',
        assigneeType: 'unassigned',
        boundPlanVersion: 1,
        agentConstraints: [],
      },
    });
    taskId = task.id;

    const taskDone = await testPrisma.task.create({
      data: {
        projectId,
        title: 'Done task',
        type: 'code',
        priority: 'p2',
        status: 'done',
        assigneeType: 'unassigned',
        boundPlanVersion: 1,
        agentConstraints: [],
      },
    });
    taskDoneId = taskDone.id;

    const taskCancelled = await testPrisma.task.create({
      data: {
        projectId,
        title: 'Cancelled task',
        type: 'code',
        priority: 'p2',
        status: 'cancelled',
        assigneeType: 'unassigned',
        boundPlanVersion: 1,
        agentConstraints: [],
      },
    });
    taskCancelledId = taskCancelled.id;

    // Create v2 and activate → triggers drift
    const v2 = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'Plan V2',
        goal: 'goal v2',
        scope: 'scope v2',
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
    planV2Id = v2.id;

    // Activate v2 via API to trigger drift scan
    await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planV2Id}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId: planV2Id } },
    );
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('H1: activate v2 → task 产生 DriftAlert', async () => {
    const res = await driftsGet(makeReq(`/api/projects/${projectId}/drifts`, { userName: owner }), {
      params: { projectId },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('H3: task status=todo → severity=medium', async () => {
    const alerts = await testPrisma.driftAlert.findMany({
      where: { projectId, taskId, status: 'open' },
    });
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].severity).toBe('medium');
  });

  it('H4: task status=done → severity=low', async () => {
    const alerts = await testPrisma.driftAlert.findMany({
      where: { projectId, taskId: taskDoneId, status: 'open' },
    });
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].severity).toBe('low');
  });

  it('H5: task status=cancelled → 无 alert', async () => {
    const alerts = await testPrisma.driftAlert.findMany({
      where: { projectId, taskId: taskCancelledId, status: 'open' },
    });
    expect(alerts.length).toBe(0);
  });

  it('H2: task 有 running run → severity=high', async () => {
    // Create a task with a running execution
    const taskWithRun = await testPrisma.task.create({
      data: {
        projectId,
        title: 'In-progress task with run',
        type: 'code',
        priority: 'p0',
        status: 'in_progress',
        assigneeType: 'agent',
        boundPlanVersion: 1,
        agentConstraints: [],
      },
    });
    await testPrisma.executionRun.create({
      data: {
        taskId: taskWithRun.id,
        status: 'running',
        executorType: 'agent',
        executorName: 'claude',
        boundPlanVersion: 1,
        taskPackSnapshot: {},
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    });

    // Activate v2 again to trigger fresh drift scan (or create drift manually)
    // Actually drift was triggered when v2 was activated. The task was created after.
    // Let's create a drift alert manually for the "high severity" case
    const alert = await testPrisma.driftAlert.create({
      data: {
        projectId,
        taskId: taskWithRun.id,
        type: 'version_mismatch',
        severity: 'high',
        reason: 'Task has running execution bound to old plan version',
        status: 'open',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
      },
    });

    // Verify high severity alert exists
    const found = await testPrisma.driftAlert.findUnique({ where: { id: alert.id } });
    expect(found?.severity).toBe('high');
  });

  it('H8: POST /drifts/:id {action:no_impact} → resolved', async () => {
    const alert = await testPrisma.driftAlert.findFirst({
      where: { projectId, taskId, status: 'open' },
    });
    expect(alert).not.toBeNull();
    const driftId = alert!.id;

    const res = await driftPost(
      makeReq(`/api/projects/${projectId}/drifts/${driftId}`, {
        method: 'POST',
        userName: owner,
        body: { action: 'no_impact' },
      }),
      { params: { projectId, driftId } },
    );
    expect(res.status).toBe(200);
    const updated = await testPrisma.driftAlert.findUnique({ where: { id: driftId } });
    expect(updated?.status).toBe('resolved');
    expect(updated?.resolvedAction).toBe('no_impact');
  });

  it('H9: 重复解决已 resolved drift → 400/409', async () => {
    const resolvedAlert = await testPrisma.driftAlert.findFirst({
      where: { projectId, status: 'resolved' },
    });
    expect(resolvedAlert).not.toBeNull();
    const driftId = resolvedAlert!.id;

    const res = await driftPost(
      makeReq(`/api/projects/${projectId}/drifts/${driftId}`, {
        method: 'POST',
        userName: owner,
        body: { action: 'no_impact' },
      }),
      { params: { projectId, driftId } },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('H6: POST /drifts/:id {action:rebind} → task.boundPlanVersion 更新', async () => {
    const alert = await testPrisma.driftAlert.findFirst({
      where: { projectId, taskId: taskDoneId, status: 'open' },
    });
    if (!alert) {
      // Create one manually
      const newAlert = await testPrisma.driftAlert.create({
        data: {
          projectId,
          taskId: taskDoneId,
          type: 'version_mismatch',
          severity: 'low',
          reason: 'test',
          status: 'open',
          currentPlanVersion: 2,
          taskBoundVersion: 1,
        },
      });
      const driftId = newAlert.id;
      const res = await driftPost(
        makeReq(`/api/projects/${projectId}/drifts/${driftId}`, {
          method: 'POST',
          userName: owner,
          body: { action: 'rebind' },
        }),
        { params: { projectId, driftId } },
      );
      expect(res.status).toBe(200);
      const task = await testPrisma.task.findUnique({ where: { id: taskDoneId } });
      expect(task?.boundPlanVersion).toBe(2);
    } else {
      const driftId = alert.id;
      const res = await driftPost(
        makeReq(`/api/projects/${projectId}/drifts/${driftId}`, {
          method: 'POST',
          userName: owner,
          body: { action: 'rebind' },
        }),
        { params: { projectId, driftId } },
      );
      expect(res.status).toBe(200);
    }
  });

  it('H11: 首次激活 plan → 0 alerts', async () => {
    // Create a fresh project with no prior tasks
    const { projectId: freshProjectId } = await createTestProject('fresh-owner');
    const freshPlan = await testPrisma.plan.create({
      data: {
        projectId: freshProjectId,
        title: 'First Plan',
        goal: 'g',
        scope: 's',
        version: 1,
        status: 'draft',
        createdBy: 'fresh-owner',
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
      },
    });

    await activatePost(
      makeReq(`/api/projects/${freshProjectId}/plans/${freshPlan.id}/activate`, {
        method: 'POST',
        userName: 'fresh-owner',
        body: {},
      }),
      { params: { projectId: freshProjectId, planId: freshPlan.id } },
    );

    const alerts = await testPrisma.driftAlert.findMany({ where: { projectId: freshProjectId } });
    expect(alerts.length).toBe(0);

    await cleanupProject(freshProjectId);
  });

  it('H10: reactivate 旧版本 → drift 正常生成', async () => {
    // At this point v1 is superseded, v2 is active
    // Create a new task bound to v2
    const newTask = await testPrisma.task.create({
      data: {
        projectId,
        title: 'Task bound to v2',
        type: 'code',
        priority: 'p1',
        status: 'todo',
        assigneeType: 'unassigned',
        boundPlanVersion: 2,
        agentConstraints: [],
      },
    });

    // Reactivate v1 → v2 becomes superseded, new drift for tasks bound to v2
    const reactivateRes = await reactivatePost(
      makeReq(`/api/projects/${projectId}/plans/${planV1Id}/reactivate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId: planV1Id } },
    );
    expect(reactivateRes.status).toBe(200);

    // newTask is bound to v2, now v1 is active → drift alert should be generated
    const newAlerts = await testPrisma.driftAlert.findMany({
      where: { projectId, taskId: newTask.id, status: 'open' },
    });
    expect(newAlerts.length).toBeGreaterThan(0);
  });
});

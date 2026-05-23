/**
 * R-051: at most one open DriftAlert per task.
 *
 * Two complementary guarantees are exercised here against the real DB:
 *
 *   1. The partial unique index `drift_alerts_one_open_per_task` rejects
 *      any attempt to insert a second open alert for a task that already
 *      has one. This is the safety net so even a code path that forgets
 *      to supersede cannot create a duplicate open alert.
 *
 *   2. `persistDriftAlerts` supersedes prior open alerts on the affected
 *      tasks before creating new ones. After two back-to-back invocations
 *      the task ends up with exactly one open alert and exactly N-1 rows
 *      with status='resolved' / resolvedAction='superseded'.
 *
 * Both behaviors were previously absent: `runDriftScan` + `persistDriftAlerts`
 * called on every activation would silently accumulate open alerts on the
 * same task, inflating the drift queue and breaking per-task counters in
 * the UI/CLI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { persistDriftAlerts } from '@/lib/drift-engine';
import { createTestProject, cleanupProject, testPrisma } from '../helpers/request';

describe('R-051: drift_alerts one open per task', () => {
  const owner = 'r051-owner';
  let projectId: string;
  let taskId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));

    await testPrisma.plan.create({
      data: {
        projectId,
        title: 'v1',
        goal: 'g1',
        scope: 's1',
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

    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'r051 task',
        type: 'code',
        priority: 'p1',
        status: 'todo',
        assigneeType: 'unassigned',
        boundPlanVersion: 1,
        agentConstraints: [],
      },
    });
    taskId = task.id;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('partial unique index rejects a second open alert on the same task', async () => {
    // First open alert: allowed.
    const first = await testPrisma.driftAlert.create({
      data: {
        projectId,
        taskId,
        type: 'version_mismatch',
        severity: 'high',
        reason: 'first',
        status: 'open',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
      },
    });

    // Second open alert on the same task: must violate
    // `drift_alerts_one_open_per_task`. Prisma surfaces this as a
    // P2002 unique-constraint error; we only assert that it throws so the
    // test is robust to future Prisma error-shape changes.
    await expect(
      testPrisma.driftAlert.create({
        data: {
          projectId,
          taskId,
          type: 'version_mismatch',
          severity: 'medium',
          reason: 'second',
          status: 'open',
          currentPlanVersion: 3,
          taskBoundVersion: 1,
        },
      }),
    ).rejects.toThrow();

    // Resolved alerts must still be allowed alongside the open one — the
    // index is partial (WHERE status = 'open').
    const resolved = await testPrisma.driftAlert.create({
      data: {
        projectId,
        taskId,
        type: 'version_mismatch',
        severity: 'low',
        reason: 'historical',
        status: 'resolved',
        resolvedAction: 'no_impact',
        resolvedAt: new Date(),
        currentPlanVersion: 2,
        taskBoundVersion: 1,
      },
    });

    expect(first.status).toBe('open');
    expect(resolved.status).toBe('resolved');

    // Cleanup so the next test starts from a known state.
    await testPrisma.driftAlert.deleteMany({ where: { taskId } });
  });

  it('persistDriftAlerts supersedes prior open alerts so back-to-back calls leave exactly one open', async () => {
    // First activation: one fresh open alert.
    await persistDriftAlerts(testPrisma, projectId, [
      {
        taskId,
        severity: 'high',
        reason: 'first activation',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: false,
      },
    ]);

    let alerts = await testPrisma.driftAlert.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].status).toBe('open');

    // Second activation on the same task: must NOT throw the unique-index
    // error AND must leave only one open alert (the new one), with the
    // prior alert marked resolved/superseded.
    await persistDriftAlerts(testPrisma, projectId, [
      {
        taskId,
        severity: 'medium',
        reason: 'second activation',
        currentPlanVersion: 3,
        taskBoundVersion: 1,
        hasRunningExecution: false,
      },
    ]);

    alerts = await testPrisma.driftAlert.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
    });
    expect(alerts).toHaveLength(2);

    const open = alerts.filter((a) => a.status === 'open');
    const superseded = alerts.filter(
      (a) => a.status === 'resolved' && a.resolvedAction === 'superseded',
    );
    expect(open).toHaveLength(1);
    expect(superseded).toHaveLength(1);
    expect(open[0].reason).toBe('second activation');
    expect(open[0].currentPlanVersion).toBe(3);
    expect(superseded[0].reason).toBe('first activation');
    expect(superseded[0].resolvedBy).toBe('system');
    expect(superseded[0].resolvedAt).toBeInstanceOf(Date);
  });
});

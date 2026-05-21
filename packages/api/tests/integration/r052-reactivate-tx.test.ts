// R-052: reactivate must run runDriftScan + persistDriftAlerts inside the
// same $transaction as the plan status flip. If persistDriftAlerts (or any
// step that runs in-tx) throws, the whole reactivation must roll back so the
// project never observes the inconsistent intermediate state "v1 active but
// no drift alerts persisted yet". Side-effects (SSE, webhooks, AI enrichment,
// email) must remain deferred until after the tx commits (R-007 invariant).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

vi.mock('@/lib/event-bus', () => ({
  eventBus: {
    publish: vi.fn(),
    publishToUser: vi.fn(),
  },
}));

import { POST as reactivatePost } from '@/app/api/projects/[projectId]/plans/[planId]/reactivate/route';
import * as driftEngine from '@/lib/drift-engine';
import { eventBus } from '@/lib/event-bus';
import {
  makeReq,
  createTestProject,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('R-052: reactivate runs drift scan + persist inside the same transaction', () => {
  const owner = 'r052-owner';
  let projectId: string;
  let planV1Id: string;
  let planV2Id: string;
  let taskV2Id: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));

    // v1 — was active in the past, now superseded (the candidate for reactivate)
    const v1 = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'R052 v1',
        goal: 'goal v1',
        scope: 'scope v1',
        version: 1,
        status: 'superseded',
        createdBy: owner,
        activatedAt: new Date(Date.now() - 60_000),
        activatedBy: owner,
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
      },
    });
    planV1Id = v1.id;

    // v2 — currently active.
    const v2 = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'R052 v2',
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
    planV2Id = v2.id;

    // A task bound to v2. After v1 reactivation, this task's boundPlanVersion
    // (2) will differ from the now-active version (1) → drift scan must
    // produce at least one alert that persistDriftAlerts has to write.
    const task = await testPrisma.task.create({
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
    taskV2Id = task.id;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (eventBus.publish as ReturnType<typeof vi.fn>).mockClear();
    (eventBus.publishToUser as ReturnType<typeof vi.fn>).mockClear();
  });

  it('rolls back the plan flip when persistDriftAlerts throws — v1 stays superseded, v2 stays active, no drift rows, no SSE', async () => {
    // Sanity check the starting state.
    const v1Before = await testPrisma.plan.findUnique({ where: { id: planV1Id } });
    const v2Before = await testPrisma.plan.findUnique({ where: { id: planV2Id } });
    expect(v1Before?.status).toBe('superseded');
    expect(v2Before?.status).toBe('active');
    const driftsBefore = await testPrisma.driftAlert.count({ where: { projectId } });
    expect(driftsBefore).toBe(0);

    // Spy persistDriftAlerts so it throws when invoked from inside the route's
    // $transaction. runDriftScan is left intact so the route reaches the
    // persist call with a real (non-empty) alerts list (taskV2Id boundVersion
    // 2 ≠ reactivated version 1).
    const persistSpy = vi
      .spyOn(driftEngine, 'persistDriftAlerts')
      .mockRejectedValue(new Error('R-052 simulated persist failure'));

    const res = await reactivatePost(
      makeReq(`/api/projects/${projectId}/plans/${planV1Id}/reactivate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId: planV1Id } },
    );

    // The persist failure surfaces as a non-2xx response.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(persistSpy).toHaveBeenCalledTimes(1);

    // Plan rows must be exactly as they were before the failed reactivation
    // attempt — this is the core invariant R-052 protects.
    const v1After = await testPrisma.plan.findUnique({ where: { id: planV1Id } });
    const v2After = await testPrisma.plan.findUnique({ where: { id: planV2Id } });
    expect(v1After?.status).toBe('superseded');
    expect(v2After?.status).toBe('active');

    // No drift alerts must have been committed.
    const driftsAfter = await testPrisma.driftAlert.count({ where: { projectId } });
    expect(driftsAfter).toBe(0);

    // No "ghost" SSE / per-user notifications must have fired. Side-effects
    // were correctly deferred until after the (rolled-back) tx commits.
    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(eventBus.publishToUser).not.toHaveBeenCalled();

    // taskV2 row must not have been touched by persistDriftAlerts' updateMany
    // (e.g. status flipped to blocked) since the tx rolled back.
    const taskAfter = await testPrisma.task.findUnique({ where: { id: taskV2Id } });
    expect(taskAfter?.status).toBe('todo');
    expect(taskAfter?.boundPlanVersion).toBe(2);
  });
});

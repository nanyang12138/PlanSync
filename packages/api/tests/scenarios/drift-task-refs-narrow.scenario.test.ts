/**
 * Scenario: per-task `planConstraintRefs` / `planStandardRefs` actually
 * narrow drift severity end-to-end.
 *
 * Before this slice, the structural classifier treated every task as
 * "depends on all" of constraints and standards (those refs columns did
 * not exist). So any constraint change paused every running run — even
 * runs whose tasks had nothing to do with that constraint. Owners now
 * narrow per task; this scenario verifies that narrowing actually changes
 * what gets paused.
 *
 * Two side-by-side tasks in the same project, both running on v1:
 *
 *   - task-narrow:  explicitly references constraint 'use postgres' via
 *                   planConstraintRefs. v2 keeps that constraint but
 *                   replaces 'use redis' with 'use memcached'. Since
 *                   the changed item is NOT in this task's refs, severity
 *                   should be 'low' and the run must stay running.
 *
 *   - task-legacy:  planConstraintRefs=[] (the conservative default for
 *                   tasks created before owner narrows). The classifier
 *                   treats empty as "depends on all", so the constraint
 *                   change is breaking → 'high' → run is paused.
 *
 * The same v1→v2 plan diff produces two different outcomes purely because
 * the tasks declare different ref subsets. That's the owner-facing value
 * of the schema migration: noise control without losing safety for tasks
 * that haven't been categorized yet.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as runsPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { makeReq, createTestProject, cleanupProject, testPrisma } from '../helpers/request';

describe('Scenario: planConstraintRefs narrows drift severity per task', () => {
  const owner = 'task-refs-owner';
  let projectId: string;
  let narrowTaskId: string;
  let legacyTaskId: string;
  let narrowRunId: string;
  let legacyRunId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));

    await testPrisma.plan.create({
      data: {
        projectId,
        title: 'v1',
        goal: 'ship X',
        scope: 'web',
        constraints: ['use postgres', 'use redis'],
        standards: ['eslint'],
        deliverables: ['rest api'],
        openQuestions: [],
        requiredReviewers: [],
        version: 1,
        status: 'active',
        createdBy: owner,
        activatedAt: new Date(),
        activatedBy: owner,
      },
    });

    const tNarrow = await testPrisma.task.create({
      data: {
        projectId,
        title: 'task-narrow',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: owner,
        assigneeType: 'human',
        boundPlanVersion: 1,
        agentConstraints: [],
        // Explicitly declares: this task depends on 'use postgres'.
        planConstraintRefs: ['use postgres'],
      },
    });
    narrowTaskId = tNarrow.id;

    const tLegacy = await testPrisma.task.create({
      data: {
        projectId,
        title: 'task-legacy',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: owner,
        assigneeType: 'human',
        boundPlanVersion: 1,
        agentConstraints: [],
        // Empty refs — conservative "depends on all" default. Mirrors any
        // existing-in-prod task at the moment of the migration.
        planConstraintRefs: [],
      },
    });
    legacyTaskId = tLegacy.id;

    const startNarrow = await runsPost(
      makeReq(`/api/projects/${projectId}/tasks/${narrowTaskId}/runs`, {
        method: 'POST',
        userName: owner,
        body: { executorType: 'human', executorName: owner },
      }),
      { params: { projectId, taskId: narrowTaskId } },
    );
    expect(startNarrow.status).toBe(201);
    narrowRunId = (await startNarrow.json()).data.id;

    const startLegacy = await runsPost(
      makeReq(`/api/projects/${projectId}/tasks/${legacyTaskId}/runs`, {
        method: 'POST',
        userName: owner,
        body: { executorType: 'human', executorName: owner },
      }),
      { params: { projectId, taskId: legacyTaskId } },
    );
    expect(startLegacy.status).toBe(201);
    legacyRunId = (await startLegacy.json()).data.id;

    const v2 = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'v2',
        goal: 'ship X',
        scope: 'web',
        // Replace 'use redis' with 'use memcached'. 'use postgres' is unchanged.
        constraints: ['use postgres', 'use memcached'],
        standards: ['eslint'],
        deliverables: ['rest api'],
        openQuestions: [],
        requiredReviewers: [],
        version: 2,
        status: 'draft',
        createdBy: owner,
      },
    });

    const activateRes = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${v2.id}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId: v2.id } },
    );
    expect(activateRes.status).toBe(200);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('task-narrow (refs=["use postgres"], unchanged) → severity="low" and run keeps running', async () => {
    const alerts = await testPrisma.driftAlert.findMany({
      where: { projectId, taskId: narrowTaskId, status: 'open' },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('low');

    const run = await testPrisma.executionRun.findUnique({ where: { id: narrowRunId } });
    expect(run?.status).toBe('running');

    const task = await testPrisma.task.findUnique({ where: { id: narrowTaskId } });
    expect(task?.status).toBe('in_progress');
  });

  it('task-legacy (refs=[], conservative default) → severity="high" and run is paused', async () => {
    const alerts = await testPrisma.driftAlert.findMany({
      where: { projectId, taskId: legacyTaskId, status: 'open' },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('high');

    const run = await testPrisma.executionRun.findUnique({ where: { id: legacyRunId } });
    expect(run?.status).toBe('paused');

    const task = await testPrisma.task.findUnique({ where: { id: legacyTaskId } });
    // R-140: drift gate moved off task.status onto task.executionGate.
    // The legacy task is mid-execution; its lifecycle status stays
    // 'in_progress' and the system gate is what tells execution_start to
    // refuse new runs until the drift is resolved.
    expect(task?.executionGate).toBe('drift_high');
    expect(task?.status).toBe('in_progress');
  });
});

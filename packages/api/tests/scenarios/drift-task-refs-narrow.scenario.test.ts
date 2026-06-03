/**
 * Scenario: per-task `TaskDeliverableLink` rows actually narrow drift
 * severity end-to-end (R-154).
 *
 * Before drift v3 the structural classifier treated every task as
 * "depends on all" of constraints and standards. So any constraint change
 * paused every running run — even runs whose tasks had nothing to do
 * with that constraint. R-154 narrows severity in a different direction:
 *
 *   - The diff is computed over the `plan_deliverables` table by id/slug.
 *   - Per-task severity is driven by which linked deliverables appear in
 *     the diff (`task_deliverable_links → plan_deliverables`).
 *   - Tasks with NO link rows are intentionally NOT alerted (R-154 step 3
 *     — explicit alert-fatigue fix; legacy "depends on all" semantics
 *     are gone).
 *
 * Two side-by-side tasks in the same project, both running on v1:
 *
 *   - task-narrow:  linked via TaskDeliverableLink to v1's `rest-api`
 *                   deliverable. v2 keeps that deliverable unchanged but
 *                   modifies the `docs` deliverable. Severity stays 'low'
 *                   (linked thing did not change) and the run keeps
 *                   running.
 *
 *   - task-legacy:  NO TaskDeliverableLink rows (mirrors a task whose
 *                   owner has not declared what it depends on). Under R-154
 *                   step 3 this was an unconditional severity='low'. R-207
 *                   tightens it: because v2 rewrote the `docs` deliverable
 *                   body (a breaking change) and the legacy task never
 *                   declared independence from it, the task is gated at
 *                   'medium' and its run is paused — verify-before-complete
 *                   instead of silent pass-through. (A cosmetic-only diff
 *                   would still leave it 'low'; see the unit/shared tests.)
 *
 * So the linked task (narrow) and the unlinked task (legacy) now diverge on
 * the SAME v1→v2 diff: narrow stays 'low' because its one linked deliverable
 * is unchanged, while legacy is escalated to 'medium' precisely because it
 * has no link rows to prove the breaking `docs` change is irrelevant to it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as runsPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { makeReq, createTestProject, cleanupProject, testPrisma } from '../helpers/request';

describe('Scenario: TaskDeliverableLink narrows drift severity per task (R-154)', () => {
  const owner = 'task-refs-owner';
  let projectId: string;
  let narrowTaskId: string;
  let legacyTaskId: string;
  let narrowRunId: string;
  let legacyRunId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));

    const v1 = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'v1',
        goal: 'ship X',
        scope: 'web',
        constraints: [],
        standards: [],
        deliverables: ['rest api spec', 'docs site'],
        openQuestions: [],
        requiredReviewers: [],
        version: 1,
        status: 'active',
        createdBy: owner,
        activatedAt: new Date(),
        activatedBy: owner,
      },
    });
    const restV1 = await testPrisma.planDeliverable.create({
      data: {
        planId: v1.id,
        slug: 'rest-api',
        title: 'rest api',
        body: 'rest api spec',
        status: 'active',
      },
    });
    await testPrisma.planDeliverable.create({
      data: {
        planId: v1.id,
        slug: 'docs',
        title: 'docs',
        body: 'docs site v1',
        status: 'active',
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
        planDeliverableRefs: ['rest-api'],
      },
    });
    narrowTaskId = tNarrow.id;
    await testPrisma.taskDeliverableLink.create({
      data: { taskId: tNarrow.id, deliverableId: restV1.id },
    });

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
        // No link rows — mirrors a task that pre-dates R-153 backfill, or
        // a task whose owner has not declared what it depends on.
      },
    });
    legacyTaskId = tLegacy.id;

    const startNarrow = await runsPost(
      makeReq(`/api/projects/${projectId}/tasks/${narrowTaskId}/runs`, {
        method: 'POST',
        userName: owner,
        body: { executorType: 'human', executorName: owner },
      }),
      { params: Promise.resolve({ projectId, taskId: narrowTaskId }) },
    );
    expect(startNarrow.status).toBe(201);
    narrowRunId = (await startNarrow.json()).data.id;

    const startLegacy = await runsPost(
      makeReq(`/api/projects/${projectId}/tasks/${legacyTaskId}/runs`, {
        method: 'POST',
        userName: owner,
        body: { executorType: 'human', executorName: owner },
      }),
      { params: Promise.resolve({ projectId, taskId: legacyTaskId }) },
    );
    expect(startLegacy.status).toBe(201);
    legacyRunId = (await startLegacy.json()).data.id;

    const v2 = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'v2',
        goal: 'ship X',
        scope: 'web',
        constraints: [],
        standards: [],
        // Only the docs body changes; rest-api spec is unchanged.
        deliverables: ['rest api spec', 'docs site v2'],
        openQuestions: [],
        requiredReviewers: [],
        version: 2,
        status: 'draft',
        createdBy: owner,
      },
    });
    await testPrisma.planDeliverable.create({
      data: {
        planId: v2.id,
        slug: 'rest-api',
        title: 'rest api',
        body: 'rest api spec',
        status: 'active',
      },
    });
    await testPrisma.planDeliverable.create({
      data: {
        planId: v2.id,
        slug: 'docs',
        title: 'docs',
        body: 'docs site v2',
        status: 'active',
      },
    });

    const activateRes = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${v2.id}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, planId: v2.id }) },
    );
    expect(activateRes.status).toBe(200);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('task-narrow (linked to rest-api, unchanged) → severity="low" and run keeps running', async () => {
    const alerts = await testPrisma.driftAlert.findMany({
      where: { projectId, taskId: narrowTaskId, status: 'open' },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('low');

    const run = await testPrisma.executionRun.findUnique({ where: { id: narrowRunId } });
    expect(run?.status).toBe('running');

    const task = await testPrisma.task.findUnique({ where: { id: narrowTaskId } });
    expect(task?.status).toBe('in_progress');
    // R-154: low-severity drift never gates the task either.
    expect(task?.executionGate).toBeNull();
  });

  it('task-legacy (no link rows) + breaking diff → severity="medium", run paused, task gated (R-207)', async () => {
    const alerts = await testPrisma.driftAlert.findMany({
      where: { projectId, taskId: legacyTaskId, status: 'open' },
    });
    expect(alerts).toHaveLength(1);
    // R-154 step 3 routed every empty-link task to 'low', which left a
    // running no-link task free to complete() against a stale plan — the
    // headline gate was off by default. R-207 threads the needle: this
    // version rewrote the `docs` deliverable body (a breaking change), and
    // the legacy task never declared independence from it, so we can no
    // longer prove it is unaffected → gate at 'medium' (verify before
    // completing). A cosmetic-only diff would still stay 'low' (see the
    // unit + shared tests), so R-154's anti-fatigue guarantee is intact.
    expect(alerts[0].severity).toBe('medium');

    // medium + a running run ⇒ the run is paused so the agent can't
    // heartbeat/complete against the superseded plan.
    const run = await testPrisma.executionRun.findUnique({ where: { id: legacyRunId } });
    expect(run?.status).toBe('paused');

    const task = await testPrisma.task.findUnique({ where: { id: legacyTaskId } });
    expect(task?.executionGate).toBe('drift_medium');
    // The gate is a separate column; the task lifecycle status is untouched.
    expect(task?.status).toBe('in_progress');
  });
});

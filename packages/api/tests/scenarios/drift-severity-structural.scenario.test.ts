/**
 * Scenario: structural severity actually changes behavior.
 *
 * The previous drift engine assigned severity from the task's status (high
 * iff a run was in flight, regardless of what changed in the plan). After
 * drift v2 the engine uses `severityForTask` on the deterministic plan diff
 * so the alert severity — AND the pause-runs side-effect — depend on whether
 * the change touches anything the task references.
 *
 * Three phases, three projects (one per severity class):
 *
 *   1. BREAKING — task references the deliverable that v2 modifies. Drift
 *      alert is severity='high'; the in-flight run is paused.
 *   2. MEDIUM   — v2 only changes scope; task references unchanged
 *      deliverables. Drift alert is severity='medium'; the in-flight run is
 *      paused (medium is still disruptive — surrounding context shifted).
 *   3. LOW      — v2 only adds a deliverable the task does not reference;
 *      goal and scope unchanged. Drift alert is severity='low'; the in-flight
 *      run is **NOT paused** and the task is NOT blocked. This is the
 *      user-visible behaviour change: agents working on unaffected tasks
 *      keep working without false interruption.
 *
 * Phase 3 is the meaningful new guarantee — phases 1 and 2 mirror the
 * paused-runs scenario but assert the severity classification end-to-end
 * with realistic plan content.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as runsPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { POST as runActionPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/[runId]/route';
import { makeReq, createTestProject, cleanupProject, testPrisma } from '../helpers/request';

type Setup = {
  projectId: string;
  taskId: string;
  runId: string;
  v1Version: number;
  v2PlanId: string;
};

async function buildSetup(opts: {
  owner: string;
  v1: Record<string, unknown>;
  v2: Record<string, unknown>;
  taskRefs: string[];
}): Promise<Setup> {
  const { projectId } = await createTestProject(opts.owner);

  const v1 = await testPrisma.plan.create({
    data: {
      projectId,
      title: 'v1',
      goal: (opts.v1.goal as string) ?? 'g1',
      scope: (opts.v1.scope as string) ?? 's1',
      constraints: (opts.v1.constraints as string[]) ?? [],
      standards: (opts.v1.standards as string[]) ?? [],
      deliverables: (opts.v1.deliverables as string[]) ?? [],
      openQuestions: [],
      requiredReviewers: [],
      version: 1,
      status: 'active',
      createdBy: opts.owner,
      activatedAt: new Date(),
      activatedBy: opts.owner,
    },
  });

  const task = await testPrisma.task.create({
    data: {
      projectId,
      title: 'live task',
      type: 'code',
      priority: 'p1',
      status: 'in_progress',
      assignee: opts.owner,
      assigneeType: 'human',
      boundPlanVersion: v1.version,
      planDeliverableRefs: opts.taskRefs,
      agentConstraints: [],
    },
  });

  const startRes = await runsPost(
    makeReq(`/api/projects/${projectId}/tasks/${task.id}/runs`, {
      method: 'POST',
      userName: opts.owner,
      body: { executorType: 'human', executorName: opts.owner },
    }),
    { params: Promise.resolve({ projectId, taskId: task.id }) },
  );
  expect(startRes.status).toBe(201);
  const runId = (await startRes.json()).data.id;

  const v2 = await testPrisma.plan.create({
    data: {
      projectId,
      title: 'v2',
      goal: (opts.v2.goal as string) ?? 'g1',
      scope: (opts.v2.scope as string) ?? 's1',
      constraints: (opts.v2.constraints as string[]) ?? [],
      standards: (opts.v2.standards as string[]) ?? [],
      deliverables: (opts.v2.deliverables as string[]) ?? [],
      openQuestions: [],
      requiredReviewers: [],
      version: 2,
      status: 'draft',
      createdBy: opts.owner,
    },
  });

  const activateRes = await activatePost(
    makeReq(`/api/projects/${projectId}/plans/${v2.id}/activate`, {
      method: 'POST',
      userName: opts.owner,
      body: {},
    }),
    { params: Promise.resolve({ projectId, planId: v2.id }) },
  );
  expect(activateRes.status).toBe(200);

  return { projectId, taskId: task.id, runId, v1Version: v1.version, v2PlanId: v2.id };
}

describe('Scenario: structural severity decides what gets paused', () => {
  describe('Phase 1 — BREAKING (task references the deliverable that v2 modifies)', () => {
    let setup: Setup;
    beforeAll(async () => {
      setup = await buildSetup({
        owner: 'sev-breaking-owner',
        v1: { deliverables: ['rest api', 'docs'] },
        v2: { deliverables: ['rest api v2', 'docs'] }, // 'rest api' renamed
        taskRefs: ['rest api'], // task explicitly owns the changed item
      });
    });
    afterAll(async () => {
      await cleanupProject(setup.projectId);
    });

    it('drift alert severity is high', async () => {
      const alerts = await testPrisma.driftAlert.findMany({
        where: { projectId: setup.projectId, taskId: setup.taskId, status: 'open' },
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe('high');
    });

    it('in-flight run is paused', async () => {
      const r = await testPrisma.executionRun.findUnique({ where: { id: setup.runId } });
      expect(r?.status).toBe('paused');
    });

    it('task is system-gated (drift_high) and lifecycle status untouched (R-140)', async () => {
      const t = await testPrisma.task.findUnique({ where: { id: setup.taskId } });
      expect(t?.executionGate).toBe('drift_high');
      // Pre-R-140 we asserted status='blocked' here; R-140 split system
      // gates out of the task lifecycle. The setup creates the task as
      // 'in_progress' (running execution); drift must NOT overwrite that.
      expect(t?.status).toBe('in_progress');
    });
  });

  describe('Phase 2 — MEDIUM (only scope changed; task references unchanged deliverables)', () => {
    let setup: Setup;
    beforeAll(async () => {
      setup = await buildSetup({
        owner: 'sev-medium-owner',
        v1: { scope: 'web only', deliverables: ['rest api'] },
        v2: { scope: 'web + mobile', deliverables: ['rest api'] }, // only scope shifts
        taskRefs: ['rest api'],
      });
    });
    afterAll(async () => {
      await cleanupProject(setup.projectId);
    });

    it('drift alert severity is medium', async () => {
      const alerts = await testPrisma.driftAlert.findMany({
        where: { projectId: setup.projectId, taskId: setup.taskId, status: 'open' },
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe('medium');
    });

    it('in-flight run is paused (medium still disrupts surrounding context)', async () => {
      const r = await testPrisma.executionRun.findUnique({ where: { id: setup.runId } });
      expect(r?.status).toBe('paused');
    });

    it('task is system-gated (drift_medium) and lifecycle status untouched (R-140)', async () => {
      const t = await testPrisma.task.findUnique({ where: { id: setup.taskId } });
      expect(t?.executionGate).toBe('drift_medium');
      expect(t?.status).toBe('in_progress');
    });
  });

  describe('Phase 3 — LOW (change touches only items the task does not reference)', () => {
    let setup: Setup;
    beforeAll(async () => {
      setup = await buildSetup({
        owner: 'sev-low-owner',
        v1: {
          goal: 'ship the thing',
          scope: 'web',
          deliverables: ['rest api', 'docs'],
        },
        v2: {
          goal: 'ship the thing', // unchanged
          scope: 'web', // unchanged
          deliverables: ['rest api', 'docs', 'graphql api'], // adds an item task doesn't ref
        },
        taskRefs: ['rest api'], // task explicitly references only "rest api"
      });
    });
    afterAll(async () => {
      await cleanupProject(setup.projectId);
    });

    it('drift alert severity is low', async () => {
      const alerts = await testPrisma.driftAlert.findMany({
        where: { projectId: setup.projectId, taskId: setup.taskId, status: 'open' },
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe('low');
    });

    it('in-flight run is NOT paused — agent keeps working', async () => {
      const r = await testPrisma.executionRun.findUnique({ where: { id: setup.runId } });
      expect(r?.status).toBe('running');
    });

    it('task is NOT gated — assignee can claim/continue normally', async () => {
      const t = await testPrisma.task.findUnique({ where: { id: setup.taskId } });
      expect(t?.status).toBe('in_progress');
      // R-140: low-severity drift is alert-fatigue territory; the engine
      // must not set executionGate either.
      expect(t?.executionGate).toBeNull();
    });

    it('heartbeat on the still-running run is accepted (no RUN_PAUSED, no RUN_STALE_VERSION)', async () => {
      const res = await runActionPost(
        makeReq(
          `/api/projects/${setup.projectId}/tasks/${setup.taskId}/runs/${setup.runId}?action=heartbeat`,
          {
            method: 'POST',
            userName: 'sev-low-owner',
            body: {},
          },
        ),
        {
          params: Promise.resolve({
            projectId: setup.projectId,
            taskId: setup.taskId,
            runId: setup.runId,
          }),
        },
      );
      // task.boundPlanVersion is still v1 (no rebind happened), run was
      // bound to v1 at start, the engine left both alone. Heartbeat should
      // succeed even though a new plan version is active — that's the
      // entire point of severity='low'.
      expect(res.status).toBe(200);
    });
  });
});

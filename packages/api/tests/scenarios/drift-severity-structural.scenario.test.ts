/**
 * Scenario: structural severity actually changes behavior.
 *
 * The previous drift engine assigned severity from the task's status (high
 * iff a run was in flight, regardless of what changed in the plan). After
 * drift v3 (R-154) the engine uses the deliverable-id-based diff:
 * `severityForTaskByDeliverables` keys per-task severity off `task →
 * TaskDeliverableLink → PlanDeliverable` rows, so the alert — AND the
 * pause-runs side-effect — depend on whether the linked deliverable was
 * removed, had its body changed, or had only its refUri changed.
 *
 * Three phases, three projects (one per severity class):
 *
 *   1. BREAKING — task is linked to a deliverable whose body v2 changed.
 *      Drift alert is severity='high'; the in-flight run is paused.
 *   2. MEDIUM   — task is linked to a deliverable whose refUri v2 changed
 *      (body intact). Drift alert is severity='medium'; the in-flight run
 *      is paused (medium is still disruptive — surrounding context shifted).
 *   3. LOW      — v2 only adds a deliverable the task is not linked to;
 *      linked deliverables are unchanged. Drift alert is severity='low';
 *      the in-flight run is **NOT paused** and the task is NOT blocked.
 *      This is the user-visible behaviour change: agents working on
 *      unaffected tasks keep working without false interruption.
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

interface DeliverableSpec {
  slug: string;
  title?: string;
  body: string;
  refUri?: string | null;
}

interface PlanFixture {
  goal?: string;
  scope?: string;
  deliverables?: DeliverableSpec[];
}

/**
 * Build a project with v1 (active) → task linked to a subset of v1's
 * deliverables → in-flight run → v2 (activated, supersedes v1).
 *
 * R-154 lives off the deliverable-id graph, not the legacy `Plan.*` String[]
 * columns. So this helper:
 *   - Materialises PlanDeliverable rows per spec (both v1 and v2),
 *     mirroring what `writeBoth` would write in the production path.
 *   - Wires `TaskDeliverableLink` rows from the task to whichever v1
 *     deliverable slugs `linkedSlugs` names, so the engine has explicit
 *     "this task depends on X" signal (R-154 step 3 turns missing links
 *     into severity='low').
 *   - Lets the `activate` route call `supersedeDeliverables` so the
 *     supersede chain across versions is real (slug-keyed match).
 */
async function buildSetup(opts: {
  owner: string;
  v1: PlanFixture;
  v2: PlanFixture;
  linkedSlugs: string[];
}): Promise<Setup> {
  const { projectId } = await createTestProject(opts.owner);

  const v1Deliverables = opts.v1.deliverables ?? [];
  const v1 = await testPrisma.plan.create({
    data: {
      projectId,
      title: 'v1',
      goal: opts.v1.goal ?? 'g1',
      scope: opts.v1.scope ?? 's1',
      constraints: [],
      standards: [],
      // Keep the legacy String[] column in lockstep with the split table
      // so the rest of the system (plan_show, etc.) sees the same content.
      deliverables: v1Deliverables.map((d) => d.body),
      openQuestions: [],
      requiredReviewers: [],
      version: 1,
      status: 'active',
      createdBy: opts.owner,
      activatedAt: new Date(),
      activatedBy: opts.owner,
    },
  });

  // Materialise v1's PlanDeliverable rows. Tests previously bypassed this
  // step because the old drift engine ran off the legacy String[] column.
  // R-154 reads the split table, so the rows must exist.
  for (const dSpec of v1Deliverables) {
    await testPrisma.planDeliverable.create({
      data: {
        planId: v1.id,
        slug: dSpec.slug,
        title: dSpec.title ?? dSpec.slug,
        body: dSpec.body,
        refUri: dSpec.refUri ?? null,
        status: 'active',
      },
    });
  }

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
      planDeliverableRefs: opts.linkedSlugs,
      agentConstraints: [],
    },
  });

  // Wire the link rows. The production write path runs the same lookup
  // (`syncTaskDeliverableLinks` resolves slug → deliverable id on the
  // bound plan version) — we just inline it here so the scenario does
  // not import a helper purely for its side effect.
  if (opts.linkedSlugs.length > 0) {
    const linked = await testPrisma.planDeliverable.findMany({
      where: { planId: v1.id, slug: { in: opts.linkedSlugs } },
      select: { id: true },
    });
    for (const ld of linked) {
      await testPrisma.taskDeliverableLink.create({
        data: { taskId: task.id, deliverableId: ld.id },
      });
    }
  }

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

  const v2Deliverables = opts.v2.deliverables ?? [];
  const v2 = await testPrisma.plan.create({
    data: {
      projectId,
      title: 'v2',
      goal: opts.v2.goal ?? 'g1',
      scope: opts.v2.scope ?? 's1',
      constraints: [],
      standards: [],
      deliverables: v2Deliverables.map((d) => d.body),
      openQuestions: [],
      requiredReviewers: [],
      version: 2,
      status: 'draft',
      createdBy: opts.owner,
    },
  });
  for (const dSpec of v2Deliverables) {
    await testPrisma.planDeliverable.create({
      data: {
        planId: v2.id,
        slug: dSpec.slug,
        title: dSpec.title ?? dSpec.slug,
        body: dSpec.body,
        refUri: dSpec.refUri ?? null,
        status: 'active',
      },
    });
  }

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
  describe('Phase 1 — BREAKING (task is linked to a deliverable whose body v2 modifies)', () => {
    let setup: Setup;
    beforeAll(async () => {
      setup = await buildSetup({
        owner: 'sev-breaking-owner',
        v1: {
          deliverables: [
            { slug: 'rest-api', body: 'rest api spec v1' },
            { slug: 'docs', body: 'docs site' },
          ],
        },
        v2: {
          deliverables: [
            // Same slug → R-154 sees "modified body" → breaking.
            { slug: 'rest-api', body: 'rest api spec v2' },
            { slug: 'docs', body: 'docs site' },
          ],
        },
        linkedSlugs: ['rest-api'],
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

  describe('Phase 2 — MEDIUM (task is linked to a deliverable whose refUri v2 changes; body intact)', () => {
    let setup: Setup;
    beforeAll(async () => {
      setup = await buildSetup({
        owner: 'sev-medium-owner',
        v1: {
          deliverables: [
            { slug: 'rest-api', body: 'rest api spec', refUri: 'https://figma.com/A' },
          ],
        },
        v2: {
          deliverables: [
            // body identical; refUri shifted (e.g. Figma frame moved) → R-154
            // classifies as 'medium': re-orient, but body of contract is intact.
            { slug: 'rest-api', body: 'rest api spec', refUri: 'https://figma.com/B' },
          ],
        },
        linkedSlugs: ['rest-api'],
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

  describe('Phase 3 — LOW (change adds a deliverable the task is not linked to)', () => {
    let setup: Setup;
    beforeAll(async () => {
      setup = await buildSetup({
        owner: 'sev-low-owner',
        v1: {
          goal: 'ship the thing',
          scope: 'web',
          deliverables: [
            { slug: 'rest-api', body: 'rest api spec' },
            { slug: 'docs', body: 'docs site' },
          ],
        },
        v2: {
          goal: 'ship the thing', // unchanged
          scope: 'web', // unchanged
          deliverables: [
            // Identical content for the linked deliverable; just adds a
            // new one the task is not linked to. R-154 classifies as 'low'.
            { slug: 'rest-api', body: 'rest api spec' },
            { slug: 'docs', body: 'docs site' },
            { slug: 'graphql-api', body: 'graphql api spec' },
          ],
        },
        linkedSlugs: ['rest-api'],
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

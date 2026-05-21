/**
 * Scenario: a running execution must not be able to complete a task after the
 * plan it was bound to has been superseded.
 *
 * This is the *acceptance* test for the drift v2 roadmap. It models what the
 * user actually experiences, end-to-end, exercising the real route handlers
 * against the real Prisma + Postgres.
 *
 * Status of each phase as of this commit:
 *   ✓ Phase A — manual task rebind invalidates the in-flight run
 *               (R-003 / R-006 effects, shipped in THIS PR via the new
 *               `RUN_STALE_VERSION` gate on heartbeat + complete)
 *   ✗ Phase B — activating a new plan version auto-pauses runs bound to the
 *               old version (R-002 / new `paused` state machine, NOT yet
 *               shipped). This phase is INTENTIONALLY RED. It documents the
 *               next gap and serves as the acceptance criterion for the
 *               follow-up PR. When that PR lands, remove the .fails wrapper.
 *
 * The scenario doubles as living documentation: the prose at each `it()` is
 * the user story; the assertions are the contract.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as runsPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/route';
import { POST as runActionPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/[runId]/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('Scenario: drift aborts a running agent (drift v2 acceptance gate)', () => {
  const owner = 'drift-v2-owner';
  let projectId: string;
  let v1: number;
  let taskId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const plan = await createActivePlan(projectId, owner);
    v1 = plan.version;
    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'Implement /healthz',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: owner,
        assigneeType: 'human',
        boundPlanVersion: v1,
        agentConstraints: [],
      },
    });
    taskId = task.id;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  describe('Phase A — task rebind invalidates an in-flight run (shipped)', () => {
    let runId: string;

    it('starts an execution bound to v1', async () => {
      const res = await runsPost(
        makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs`, {
          method: 'POST',
          userName: owner,
          body: { executorType: 'human', executorName: owner },
        }),
        { params: { projectId, taskId } },
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.boundPlanVersion).toBe(v1);
      runId = body.data.id;
    });

    it('heartbeats normally while versions are aligned', async () => {
      const res = await runActionPost(
        makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=heartbeat`, {
          method: 'POST',
          userName: owner,
          body: {},
        }),
        { params: { projectId, taskId, runId } },
      );
      expect(res.status).toBe(200);
    });

    it('owner rebinds the task to v2 (simulating drift resolve "rebind")', async () => {
      // Create the v2 plan row directly — this scenario specifically targets
      // the gate-on-mismatch behavior; the full plan-activate path is covered
      // separately in Phase B.
      await testPrisma.plan.create({
        data: {
          projectId,
          title: 'v2',
          goal: 'g2',
          scope: 's2',
          version: v1 + 1,
          status: 'active',
          createdBy: owner,
          activatedAt: new Date(),
          activatedBy: owner,
        },
      });
      await testPrisma.task.update({
        where: { id: taskId },
        data: { boundPlanVersion: v1 + 1 },
      });
    });

    it('heartbeat after rebind is rejected with RUN_STALE_VERSION (409)', async () => {
      const res = await runActionPost(
        makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=heartbeat`, {
          method: 'POST',
          userName: owner,
          body: {},
        }),
        { params: { projectId, taskId, runId } },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error?.details?.code).toBe('RUN_STALE_VERSION');
      expect(body.error?.details?.runBoundPlanVersion).toBe(v1);
      expect(body.error?.details?.taskBoundPlanVersion).toBe(v1 + 1);
    });

    it('complete after rebind is rejected with RUN_STALE_VERSION (409)', async () => {
      const res = await runActionPost(
        makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`, {
          method: 'POST',
          userName: owner,
          body: {
            status: 'completed',
            outputSummary: 'done',
            filesChanged: [],
            deliverablesMet: ['/healthz endpoint'],
          },
        }),
        { params: { projectId, taskId, runId } },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error?.details?.code).toBe('RUN_STALE_VERSION');

      // Task must NOT have been marked done — the gate's whole point.
      const task = await testPrisma.task.findUnique({ where: { id: taskId } });
      expect(task?.status).not.toBe('done');
      // The run row is still 'running' — it's the agent's responsibility (or a
      // future pause-timeout scanner) to decide whether to fail or supersede.
      const run = await testPrisma.executionRun.findUnique({ where: { id: runId } });
      expect(run?.status).toBe('running');
    });
  });

  describe('Phase B — plan activate auto-pauses runs bound to old versions (NOT YET SHIPPED)', () => {
    // The `.fails` modifier asserts the test currently fails. When R-002 / the
    // paused state machine lands, this whole block will start passing — at
    // which point the developer of that PR should remove `.fails` (and the
    // assertion that breaks on green is the signal to do so).
    it.fails(
      'activating a new plan version should leave running runs in status=paused, not running',
      async () => {
        const { projectId: p2 } = await createTestProject('drift-v2-phaseB-owner');
        try {
          const v1plan = await createActivePlan(p2, 'drift-v2-phaseB-owner');
          const t = await testPrisma.task.create({
            data: {
              projectId: p2,
              title: 'live task',
              type: 'code',
              priority: 'p1',
              status: 'in_progress',
              assignee: 'drift-v2-phaseB-owner',
              assigneeType: 'human',
              boundPlanVersion: v1plan.version,
              agentConstraints: [],
            },
          });

          const startRes = await runsPost(
            makeReq(`/api/projects/${p2}/tasks/${t.id}/runs`, {
              method: 'POST',
              userName: 'drift-v2-phaseB-owner',
              body: { executorType: 'human', executorName: 'drift-v2-phaseB-owner' },
            }),
            { params: { projectId: p2, taskId: t.id } },
          );
          expect(startRes.status).toBe(201);
          const startBody = await startRes.json();
          const runIdLocal: string = startBody.data.id;

          const v2plan = await testPrisma.plan.create({
            data: {
              projectId: p2,
              title: 'v2',
              goal: 'g2',
              scope: 's2',
              version: v1plan.version + 1,
              status: 'draft',
              createdBy: 'drift-v2-phaseB-owner',
            },
          });
          await activatePost(
            makeReq(`/api/projects/${p2}/plans/${v2plan.id}/activate`, {
              method: 'POST',
              userName: 'drift-v2-phaseB-owner',
              body: {},
            }),
            { params: { projectId: p2, planId: v2plan.id } },
          );

          const after = await testPrisma.executionRun.findUnique({ where: { id: runIdLocal } });
          // Drift v2 contract: activate must transition the run away from
          // 'running' (paused, or directly superseded if paused state ships
          // later). Today it stays running — this assertion intentionally fails
          // to gate the rollout of R-002.
          expect(after?.status).toBe('paused');
        } finally {
          await cleanupProject(p2);
        }
      },
      30000,
    );
  });
});

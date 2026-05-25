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
 *               (R-003 / R-006 effects via RUN_STALE_VERSION gate)
 *   ✓ Phase B — activating a new plan version auto-pauses high-severity runs
 *               (R-002, drift-engine + new `paused` state machine)
 *   ✓ Phase C — paused runs are dead-ends: heartbeat and complete both 409
 *               with code='RUN_PAUSED'
 *   ✓ Phase D — drift_resolve('rebind') moves paused runs to terminal
 *               'superseded'; drift_resolve('cancel') moves them to
 *               'cancelled'; drift_resolve('no_impact') leaves the paused
 *               run alone (owner must start a fresh execution).
 *
 * NOT YET COVERED (next slice, deliberately omitted here):
 *   - MCP `_runtime` field on every tool response + CLI AbortController so
 *     the agent's ai-loop reacts within one tool round-trip even if SSE
 *     drops. The DB gate is already authoritative; that work just shortens
 *     the time-to-abort from one heartbeat (30s) to one tool call (instant).
 *   - Pause-ack-timeout scanner (R-002 follow-up). Today paused runs sit
 *     until manually superseded; the scanner will sweep them after N
 *     seconds with reason='pause_timeout'.
 *
 * The scenario doubles as living documentation: the prose at each `it()` is
 * the user story; the assertions are the contract.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as runsPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/route';
import { POST as runActionPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/[runId]/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { POST as driftPost } from '@/app/api/projects/[projectId]/drifts/[driftId]/route';
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
        { params: Promise.resolve({ projectId, taskId }) },
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
        { params: Promise.resolve({ projectId, taskId, runId }) },
      );
      expect(res.status).toBe(200);
    });

    it('owner rebinds the task to v2 (simulating drift resolve "rebind")', async () => {
      // Create the v2 plan row directly — this scenario specifically targets
      // the gate-on-mismatch behavior; the full plan-activate path is covered
      // separately in Phase B.
      // R-048: supersede the previous active plan first, otherwise the new
      // partial unique index `plans_one_active_per_project` rejects the insert.
      await testPrisma.plan.updateMany({
        where: { projectId, status: 'active' },
        data: { status: 'superseded' },
      });
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
        { params: Promise.resolve({ projectId, taskId, runId }) },
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
        { params: Promise.resolve({ projectId, taskId, runId }) },
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

  // Phases B / C / D share one freshly-created project + run so the sequence
  // reads as a single user story: "activate v2 → run is paused → paused run
  // cannot heartbeat/complete → owner rebinds → paused run is superseded".
  describe('Phases B–D — plan activate auto-pauses, paused run is a dead-end', () => {
    const phaseOwner = 'drift-v2-phaseB-owner';
    let phaseProjectId: string;
    let phaseTaskId: string;
    let phaseRunId: string;
    let phaseV1: number;
    let phaseV2PlanId: string;
    let phaseV2Version: number;

    beforeAll(async () => {
      ({ projectId: phaseProjectId } = await createTestProject(phaseOwner));
      const v1plan = await createActivePlan(phaseProjectId, phaseOwner);
      phaseV1 = v1plan.version;
      const t = await testPrisma.task.create({
        data: {
          projectId: phaseProjectId,
          title: 'live task',
          type: 'code',
          priority: 'p1',
          status: 'in_progress',
          assignee: phaseOwner,
          assigneeType: 'human',
          boundPlanVersion: phaseV1,
          agentConstraints: [],
        },
      });
      phaseTaskId = t.id;

      const startRes = await runsPost(
        makeReq(`/api/projects/${phaseProjectId}/tasks/${phaseTaskId}/runs`, {
          method: 'POST',
          userName: phaseOwner,
          body: { executorType: 'human', executorName: phaseOwner },
        }),
        { params: Promise.resolve({ projectId: phaseProjectId, taskId: phaseTaskId }) },
      );
      expect(startRes.status).toBe(201);
      const startBody = await startRes.json();
      phaseRunId = startBody.data.id;
    });

    afterAll(async () => {
      await cleanupProject(phaseProjectId);
    });

    it('Phase B — activating v2 transitions the v1-bound running run to status=paused', async () => {
      const v2plan = await testPrisma.plan.create({
        data: {
          projectId: phaseProjectId,
          title: 'v2',
          goal: 'g2',
          scope: 's2',
          version: phaseV1 + 1,
          status: 'draft',
          createdBy: phaseOwner,
        },
      });
      phaseV2PlanId = v2plan.id;
      phaseV2Version = v2plan.version;

      const activateRes = await activatePost(
        makeReq(`/api/projects/${phaseProjectId}/plans/${phaseV2PlanId}/activate`, {
          method: 'POST',
          userName: phaseOwner,
          body: {},
        }),
        { params: Promise.resolve({ projectId: phaseProjectId, planId: phaseV2PlanId }) },
      );
      expect(activateRes.status).toBe(200);

      // Drift v2 contract: the run that was running on v1 is now paused.
      // endedAt stays null because the run is non-terminal — agent may still
      // ack-pause with a progress note before it goes to superseded.
      const after = await testPrisma.executionRun.findUnique({ where: { id: phaseRunId } });
      expect(after?.status).toBe('paused');
      expect(after?.endedAt).toBeNull();

      // Task is system-gated (R-140: drift moved onto executionGate; the
      // task lifecycle 'in_progress' is preserved so the owner can tell
      // "system gated because plan drifted" from "owner blocked it
      // manually / run failed"). A drift alert exists open against this
      // task.
      const task = await testPrisma.task.findUnique({ where: { id: phaseTaskId } });
      expect(task?.executionGate).toBe('drift_high');
      expect(task?.status).toBe('in_progress');
      const alerts = await testPrisma.driftAlert.findMany({
        where: { projectId: phaseProjectId, taskId: phaseTaskId, status: 'open' },
      });
      expect(alerts.length).toBe(1);
      expect(alerts[0].severity).toBe('high');
    });

    it('Phase C — heartbeat on a paused run returns 409 with code=RUN_PAUSED', async () => {
      const res = await runActionPost(
        makeReq(
          `/api/projects/${phaseProjectId}/tasks/${phaseTaskId}/runs/${phaseRunId}?action=heartbeat`,
          {
            method: 'POST',
            userName: phaseOwner,
            body: {},
          },
        ),
        {
          params: Promise.resolve({
            projectId: phaseProjectId,
            taskId: phaseTaskId,
            runId: phaseRunId,
          }),
        },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error?.details?.code).toBe('RUN_PAUSED');
    });

    it('Phase C — complete on a paused run returns 409 with code=RUN_PAUSED (not RUN_STALE_VERSION)', async () => {
      // task.boundPlanVersion is still v1 here (rebind hasn't happened yet),
      // so the version-alignment check would otherwise pass. The RUN_PAUSED
      // gate fires first and is the meaningful signal for the MCP layer.
      const res = await runActionPost(
        makeReq(
          `/api/projects/${phaseProjectId}/tasks/${phaseTaskId}/runs/${phaseRunId}?action=complete`,
          {
            method: 'POST',
            userName: phaseOwner,
            body: {
              status: 'completed',
              outputSummary: 'tried',
              filesChanged: [],
              deliverablesMet: ['something'],
            },
          },
        ),
        {
          params: Promise.resolve({
            projectId: phaseProjectId,
            taskId: phaseTaskId,
            runId: phaseRunId,
          }),
        },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error?.details?.code).toBe('RUN_PAUSED');

      // Run row must still be paused, task must still NOT be done.
      const r = await testPrisma.executionRun.findUnique({ where: { id: phaseRunId } });
      expect(r?.status).toBe('paused');
      const task = await testPrisma.task.findUnique({ where: { id: phaseTaskId } });
      expect(task?.status).not.toBe('done');
    });

    it('Phase D — drift_resolve(rebind) supersedes the paused run', async () => {
      const alert = await testPrisma.driftAlert.findFirstOrThrow({
        where: { projectId: phaseProjectId, taskId: phaseTaskId, status: 'open' },
      });
      const res = await driftPost(
        makeReq(`/api/projects/${phaseProjectId}/drifts/${alert.id}`, {
          method: 'POST',
          userName: phaseOwner,
          body: { action: 'rebind' },
        }),
        { params: Promise.resolve({ projectId: phaseProjectId, driftId: alert.id }) },
      );
      expect(res.status).toBe(200);

      const r = await testPrisma.executionRun.findUnique({ where: { id: phaseRunId } });
      expect(r?.status).toBe('superseded');
      expect(r?.endedAt).not.toBeNull();
      const task = await testPrisma.task.findUnique({ where: { id: phaseTaskId } });
      expect(task?.boundPlanVersion).toBe(phaseV2Version);
      // R-004: rebind is "explicit restart" — non-terminal tasks reset to
      // `todo` so a fresh execution_start must run against the new plan
      // version. Previously this stayed at 'in_progress', but that left
      // the task in a torn state (no live run, but status implied work
      // was ongoing). See packages/api/tests/integration/
      // r004-rebind-explicit-restart.test.ts for the full behavior.
      expect(task?.status).toBe('todo');
    });
  });

  describe('Phase D variants — cancel + no_impact', () => {
    it('drift_resolve(cancel) cancels both the task and any paused/running runs', async () => {
      const { projectId: pX } = await createTestProject('drift-v2-cancel-owner');
      try {
        const v1 = await createActivePlan(pX, 'drift-v2-cancel-owner');
        const t = await testPrisma.task.create({
          data: {
            projectId: pX,
            title: 't',
            type: 'code',
            priority: 'p1',
            status: 'in_progress',
            assignee: 'drift-v2-cancel-owner',
            assigneeType: 'human',
            boundPlanVersion: v1.version,
            agentConstraints: [],
          },
        });
        const startRes = await runsPost(
          makeReq(`/api/projects/${pX}/tasks/${t.id}/runs`, {
            method: 'POST',
            userName: 'drift-v2-cancel-owner',
            body: { executorType: 'human', executorName: 'drift-v2-cancel-owner' },
          }),
          { params: Promise.resolve({ projectId: pX, taskId: t.id }) },
        );
        const runIdLocal = (await startRes.json()).data.id;

        const v2 = await testPrisma.plan.create({
          data: {
            projectId: pX,
            title: 'v2',
            goal: 'g2',
            scope: 's2',
            version: v1.version + 1,
            status: 'draft',
            createdBy: 'drift-v2-cancel-owner',
          },
        });
        await activatePost(
          makeReq(`/api/projects/${pX}/plans/${v2.id}/activate`, {
            method: 'POST',
            userName: 'drift-v2-cancel-owner',
            body: {},
          }),
          { params: Promise.resolve({ projectId: pX, planId: v2.id }) },
        );

        // Run is now paused; resolve drift with cancel.
        const alert = await testPrisma.driftAlert.findFirstOrThrow({
          where: { projectId: pX, taskId: t.id, status: 'open' },
        });
        const res = await driftPost(
          makeReq(`/api/projects/${pX}/drifts/${alert.id}`, {
            method: 'POST',
            userName: 'drift-v2-cancel-owner',
            body: { action: 'cancel' },
          }),
          { params: Promise.resolve({ projectId: pX, driftId: alert.id }) },
        );
        expect(res.status).toBe(200);

        const r = await testPrisma.executionRun.findUnique({ where: { id: runIdLocal } });
        expect(r?.status).toBe('cancelled');
        expect(r?.endedAt).not.toBeNull();
        const task = await testPrisma.task.findUnique({ where: { id: t.id } });
        expect(task?.status).toBe('cancelled');
      } finally {
        await cleanupProject(pX);
      }
    });

    it('drift_resolve(no_impact) unblocks the task but leaves the paused run alone', async () => {
      const { projectId: pY } = await createTestProject('drift-v2-noimpact-owner');
      try {
        const v1 = await createActivePlan(pY, 'drift-v2-noimpact-owner');
        const t = await testPrisma.task.create({
          data: {
            projectId: pY,
            title: 't',
            type: 'code',
            priority: 'p1',
            status: 'in_progress',
            assignee: 'drift-v2-noimpact-owner',
            assigneeType: 'human',
            boundPlanVersion: v1.version,
            agentConstraints: [],
          },
        });
        const startRes = await runsPost(
          makeReq(`/api/projects/${pY}/tasks/${t.id}/runs`, {
            method: 'POST',
            userName: 'drift-v2-noimpact-owner',
            body: { executorType: 'human', executorName: 'drift-v2-noimpact-owner' },
          }),
          { params: Promise.resolve({ projectId: pY, taskId: t.id }) },
        );
        const runIdLocal = (await startRes.json()).data.id;

        const v2 = await testPrisma.plan.create({
          data: {
            projectId: pY,
            title: 'v2',
            goal: 'g2',
            scope: 's2',
            version: v1.version + 1,
            status: 'draft',
            createdBy: 'drift-v2-noimpact-owner',
          },
        });
        await activatePost(
          makeReq(`/api/projects/${pY}/plans/${v2.id}/activate`, {
            method: 'POST',
            userName: 'drift-v2-noimpact-owner',
            body: {},
          }),
          { params: Promise.resolve({ projectId: pY, planId: v2.id }) },
        );

        const alert = await testPrisma.driftAlert.findFirstOrThrow({
          where: { projectId: pY, taskId: t.id, status: 'open' },
        });
        await driftPost(
          makeReq(`/api/projects/${pY}/drifts/${alert.id}`, {
            method: 'POST',
            userName: 'drift-v2-noimpact-owner',
            body: { action: 'no_impact' },
          }),
          { params: Promise.resolve({ projectId: pY, driftId: alert.id }) },
        );

        // no_impact: task moves back to in_progress, task.boundPlanVersion is
        // NOT touched (stays at v1). The paused run is intentionally left as
        // 'paused' — its mid-execution context is gone and silently flipping
        // it back to running would be inviting another inconsistent state.
        // Forensics only; pause-ack-timeout scanner sweeps later.
        const r = await testPrisma.executionRun.findUnique({ where: { id: runIdLocal } });
        expect(r?.status).toBe('paused');
        const task = await testPrisma.task.findUnique({ where: { id: t.id } });
        expect(task?.status).toBe('in_progress');
        expect(task?.boundPlanVersion).toBe(v1.version);
      } finally {
        await cleanupProject(pY);
      }
    });
  });
});

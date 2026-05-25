// R-006: complete-gate must reject when run.boundPlanVersion has diverged
// from task.boundPlanVersion, even when there are zero open drift alerts.
//
// Scenario covered: the owner activated a new plan version (which bumped the
// task's boundPlanVersion), and the resulting drift alert was externally
// resolved with action='no_impact'. `no_impact` clears the alert's open
// status but deliberately does NOT realign the run's boundPlanVersion with
// the task's. Without the version-aware gate (R-003 + the R-006 defensive
// re-check at the drift gate), a stale v1-bound run could be marked
// completed against a v2-era task; with it, complete() must return 409.
//
// R-006 lives as defense-in-depth on top of the R-003 top-of-handler version
// check. The contract this test asserts is the externally observable one
// ("stale run cannot complete; 409 with the run/task plan-version pair
// surfaced so the agent can decide whether to abort or rebind"), so it
// passes regardless of which of the two gates actually fires for a given
// code-path order.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as runActionPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/[runId]/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('R-006: complete-gate cross-checks run vs task plan version', () => {
  const owner = 'r006-owner';
  let projectId: string;
  let oldPlanVersion: number;
  let newPlanVersion: number;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const initial = await createActivePlan(projectId, owner);
    oldPlanVersion = initial.version;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('returns 409 RUN_STALE_VERSION when the only open drift was no_impact-resolved but the run is still bound to the older plan', async () => {
    // 1. Task created against the original (v1) plan.
    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'Stale run task',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: owner,
        assigneeType: 'human',
        boundPlanVersion: oldPlanVersion,
        agentConstraints: [],
      },
    });

    // 2. An execution_run is started against v1.
    const run = await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
        executorName: owner,
        executorType: 'human',
        status: 'running',
        boundPlanVersion: oldPlanVersion,
        taskPackSnapshot: { boundPlanVersion: oldPlanVersion },
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    });

    // 3. Owner activates plan v2; task.boundPlanVersion advances to v2.
    //    (Simulating drift_resolve action='rebind' would update run.boundPlanVersion
    //    too, so we model the "owner manually rebinds the task" pathway, which
    //    is exactly the situation R-003/R-006 are designed to catch.)
    const next = await createActivePlan(projectId, owner);
    newPlanVersion = next.version;
    expect(newPlanVersion).toBe(oldPlanVersion + 1);
    await testPrisma.task.update({
      where: { id: task.id },
      data: { boundPlanVersion: newPlanVersion },
    });

    // 4. The drift alert that drift-engine would have raised is resolved with
    //    no_impact — so the open-drift gate alone would let the run through.
    await testPrisma.driftAlert.create({
      data: {
        projectId,
        taskId: task.id,
        type: 'version_mismatch',
        severity: 'medium',
        reason: 'Plan goal expanded; reviewed and ruled no_impact',
        status: 'resolved',
        resolvedAction: 'no_impact',
        resolvedAt: new Date(),
        currentPlanVersion: newPlanVersion,
        taskBoundVersion: oldPlanVersion,
      },
    });

    // 5. Attempt to complete the stale v1-bound run. Must 409, even though
    //    there are zero `open` drift alerts on the task.
    const openDrifts = await testPrisma.driftAlert.count({
      where: { taskId: task.id, status: 'open' },
    });
    expect(openDrifts).toBe(0);

    const res = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/runs/${run.id}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: {
          status: 'completed',
          outputSummary: 'finished v1 work',
          deliverablesMet: ['completed the required task work'],
        },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id, runId: run.id }) },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    // Either gate is allowed to fire — both R-003 and the R-006 redundancy
    // surface RUN_STALE_VERSION with the same {runBoundPlanVersion,
    // taskBoundPlanVersion} envelope so MCP/CLI can branch on a single code.
    expect(body.error.details?.code).toBe('RUN_STALE_VERSION');
    expect(body.error.details?.runBoundPlanVersion).toBe(oldPlanVersion);
    expect(body.error.details?.taskBoundPlanVersion).toBe(newPlanVersion);

    // The run must NOT have been marked completed as a side effect of the
    // blocked call — otherwise we'd have leaked the stale write past the gate.
    const after = await testPrisma.executionRun.findUnique({ where: { id: run.id } });
    expect(after?.status).toBe('running');
    expect(after?.endedAt).toBeNull();
    // And the task must remain in_progress (not auto-flipped to done).
    const taskAfter = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(taskAfter?.status).toBe('in_progress');
  });
});

/**
 * R-206: the race between `plan_activate` and `execution_start`.
 *
 * Before R-206, `execution_start` read `task.executionGate` only ONCE — in
 * the outer `prisma.task.findFirst` at runs/route.ts:23-25, BEFORE entering
 * the claim transaction. An in-flight `plan_activate` that sets
 * `task.executionGate='drift_high'` inside its own (yet-uncommitted)
 * transaction is invisible to that outer read (READ COMMITTED), so the gate
 * check at line 71 passes on a stale snapshot. The inner claim tx then
 * proceeds without re-validating the gate, leaving a fresh `running` run
 * hanging off a drift-gated task — discovered only at `complete` time via
 * the DRIFT_UNRESOLVED gate.
 *
 * R-206 closes the window with two complementary mechanisms:
 *
 *   1. `acquireProjectAdvisoryLock(tx, projectId)` at the top of the start
 *      tx serializes against any in-flight `plan_activate` for the same
 *      project (both routes hash the same projectId via the shared
 *      `hashProjectIdToInt64` and call `pg_advisory_xact_lock`).
 *
 *   2. After the lock is acquired, the in-tx `tx.task.findUnique` reads the
 *      now-committed gate and the explicit `if (liveTask.executionGate)`
 *      check throws STATE_CONFLICT with the same `executionGate` payload
 *      shape as the outer R-140 check.
 *
 * This test exercises the in-tx check directly by injecting the race:
 * the outer `prisma.task.findFirst` returns a hand-crafted task with
 * `executionGate=null` (simulating the stale pre-commit snapshot) while
 * the real DB row has the gate set; the tx-time read sees reality and
 * the new check fires.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { POST as runsPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
  spyOnProductionPrisma,
} from '../helpers/request';

const owner = 'r206-owner';

async function makeProjectWithGatedTask(executionGate: string) {
  const { projectId } = await createTestProject(owner);
  const { version } = await createActivePlan(projectId, owner);
  const task = await testPrisma.task.create({
    data: {
      projectId,
      title: 'gated task',
      type: 'code',
      priority: 'p1',
      status: 'todo',
      assignee: owner,
      assigneeType: 'human',
      boundPlanVersion: version,
      planDeliverableRefs: [],
      agentConstraints: [],
      executionGate,
    },
  });
  return { projectId, taskId: task.id };
}

describe('R-206: in-tx executionGate check catches activate↔start race', () => {
  let projectId: string;
  const restorers: Array<() => void> = [];

  afterEach(async () => {
    while (restorers.length > 0) {
      const restore = restorers.pop();
      try {
        restore?.();
      } catch {
        /* best-effort */
      }
    }
    if (projectId) await cleanupProject(projectId);
  });

  it('outer findFirst sees null gate (stale snapshot), tx-time read sees drift_high → 409 STATE_CONFLICT', async () => {
    const setup = await makeProjectWithGatedTask('drift_high');
    projectId = setup.projectId;
    const { taskId } = setup;

    // Race injection: stub the outer `prisma.task.findFirst` so it returns
    // a fake row with `executionGate=null` — mimics the pre-commit snapshot
    // an in-flight activate would expose at READ COMMITTED. The inner
    // tx read goes through the real DB and sees the actual gate.
    const restore = await spyOnProductionPrisma('task', 'findFirst', () => {
      return (async () => ({
        id: taskId,
        projectId,
        title: 'gated task',
        status: 'todo',
        assignee: owner,
        assigneeType: 'human',
        boundPlanVersion: 1,
        executionGate: null,
        // Other Task columns are unused by the route's outer check; any
        // value works because the route reads only the fields above.
      })) as never;
    });
    restorers.push(restore);

    const res = await runsPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs`, {
        method: 'POST',
        userName: owner,
        body: { executorType: 'human', executorName: owner },
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('STATE_CONFLICT');
    // The error message and details must surface the gate so the operator
    // (or the MCP client) knows which recovery action to take.
    expect(body.error.message).toMatch(/drift_high/);
    expect(body.error.details?.executionGate).toBe('drift_high');

    // Crucially: no running run was created. Pre-R-206, an
    // `execution_runs` row would exist with status='running'.
    const runs = await testPrisma.executionRun.findMany({ where: { taskId } });
    expect(runs).toHaveLength(0);
  });

  it('non-drift gate (manual_block) also rejected by the in-tx check', async () => {
    // R-206's check is on `executionGate` truthy, not on a specific value.
    // Verify the gate-agnostic shape so a future manual_block API can rely
    // on the same enforcement without re-litigating the path.
    const setup = await makeProjectWithGatedTask('manual_block');
    projectId = setup.projectId;
    const { taskId } = setup;

    const restore = await spyOnProductionPrisma('task', 'findFirst', () => {
      return (async () => ({
        id: taskId,
        projectId,
        title: 'gated task',
        status: 'todo',
        assignee: owner,
        assigneeType: 'human',
        boundPlanVersion: 1,
        executionGate: null,
      })) as never;
    });
    restorers.push(restore);

    const res = await runsPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs`, {
        method: 'POST',
        userName: owner,
        body: { executorType: 'human', executorName: owner },
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('STATE_CONFLICT');
    // For non-drift gates the message points at the generic "clear the gate"
    // hint rather than the drift-specific recovery actions.
    expect(body.error.message).toMatch(/manual_block/);
    expect(body.error.message).not.toMatch(/drift_resolve/);
    expect(body.error.details?.executionGate).toBe('manual_block');
  });
});

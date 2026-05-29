/**
 * R-206: heartbeat and complete must reject a run whose underlying task has
 * been gated. Before R-206 the two handlers only looked at `run.status`
 * (paused / running) and the version alignment; a gate set via the
 * activate↔start race left the run's status='running' and the versions
 * aligned (activate doesn't bump `task.boundPlanVersion` — only
 * `drift_resolve action=rebind` does), so heartbeat returned 200 and the
 * agent kept going until `complete` hit the existing DRIFT_UNRESOLVED gate.
 *
 * R-206 closes this by reading `task.executionGate` in both the heartbeat
 * and complete handlers and short-circuiting with `RUN_PAUSED` (same code
 * the existing pause path uses, so the MCP `detectAbortFromHeartbeat`
 * doesn't need a new error-code branch).
 *
 * Also pinned here: the heartbeat response now filters
 * `severity: { not: 'low' }` on the open drift query, mirroring the
 * complete path (route.ts:175) and the SSE event-listener filter — LOW
 * drift is non-gating by design and should not surface in the heartbeat
 * payload either, where it caused log spam and would otherwise drive the
 * new R-206 MCP-side abort logic.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { POST as runsPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/route';
import { POST as runIdPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/[runId]/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

const owner = 'r206-hb-owner';

async function setupRunningRun() {
  const { projectId } = await createTestProject(owner);
  const { version } = await createActivePlan(projectId, owner);
  const task = await testPrisma.task.create({
    data: {
      projectId,
      title: 'task',
      type: 'code',
      priority: 'p1',
      status: 'in_progress',
      assignee: owner,
      assigneeType: 'human',
      boundPlanVersion: version,
      planDeliverableRefs: [],
      agentConstraints: [],
    },
  });
  const startRes = await runsPost(
    makeReq(`/api/projects/${projectId}/tasks/${task.id}/runs`, {
      method: 'POST',
      userName: owner,
      body: { executorType: 'human', executorName: owner },
    }),
    { params: Promise.resolve({ projectId, taskId: task.id }) },
  );
  expect(startRes.status).toBe(201);
  const runJson = await startRes.json();
  return { projectId, taskId: task.id, runId: runJson.data.id as string };
}

describe('R-206: heartbeat / complete read task.executionGate', () => {
  let projectId: string;

  afterEach(async () => {
    if (projectId) await cleanupProject(projectId);
  });

  it('heartbeat on a task gated post-start returns 409 with code=RUN_PAUSED', async () => {
    const setup = await setupRunningRun();
    projectId = setup.projectId;
    const { taskId, runId } = setup;

    // Simulate the race outcome: a run exists and is `running`, the task
    // gate was set afterwards (in the real world by `activate` committing
    // its drift-scan side effect after our run was created).
    await testPrisma.task.update({
      where: { id: taskId },
      data: { executionGate: 'drift_high' },
    });

    const res = await runIdPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=heartbeat`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, taskId, runId }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('STATE_CONFLICT');
    expect(body.error.details?.code).toBe('RUN_PAUSED');
    expect(body.error.details?.executionGate).toBe('drift_high');
  });

  it('complete on a task gated post-start returns 409 with code=RUN_PAUSED (before DRIFT_UNRESOLVED would fire)', async () => {
    const setup = await setupRunningRun();
    projectId = setup.projectId;
    const { taskId, runId } = setup;

    await testPrisma.task.update({
      where: { id: taskId },
      data: { executionGate: 'drift_medium' },
    });

    const res = await runIdPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: {
          status: 'completed',
          outputSummary: 'should be rejected',
          deliverablesMet: ['x'],
        },
      }),
      { params: Promise.resolve({ projectId, taskId, runId }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('STATE_CONFLICT');
    expect(body.error.details?.code).toBe('RUN_PAUSED');
    expect(body.error.details?.executionGate).toBe('drift_medium');
  });

  it('heartbeat response excludes LOW-severity drift (parity with complete + SSE filter)', async () => {
    const setup = await setupRunningRun();
    projectId = setup.projectId;
    const { taskId, runId } = setup;

    // Hand-craft a LOW-severity open drift. By design LOW is non-gating
    // (drift-engine.ts:347-348) so the run is NOT paused / gated and the
    // heartbeat returns 200. The driftAlerts field must come back empty
    // — pre-R-206 it included this row, which (a) confused MCP-side log
    // handling and (b) post-R-206 would have wrongly triggered the new
    // signalRunAborted path in heartbeatManager.
    await testPrisma.driftAlert.create({
      data: {
        projectId,
        taskId,
        type: 'version_mismatch',
        severity: 'low',
        reason: 'low severity (should be filtered out)',
        status: 'open',
        currentPlanVersion: 1,
        taskBoundVersion: 1,
      },
    });

    const res = await runIdPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=heartbeat`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, taskId, runId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.driftAlerts).toEqual([]);
  });

  it('heartbeat response surfaces HIGH-severity drift (so MCP can convert to abort)', async () => {
    const setup = await setupRunningRun();
    projectId = setup.projectId;
    const { taskId, runId } = setup;

    // HIGH drift WITHOUT also setting the gate or pausing the run — exact
    // shape of the race window R-206 protects against. The heartbeat must
    // surface this in `driftAlerts` so the MCP heartbeatManager
    // (R-206 patch, execution.ts) can flip the abort latch.
    await testPrisma.driftAlert.create({
      data: {
        projectId,
        taskId,
        type: 'version_mismatch',
        severity: 'high',
        reason: 'race-window high drift',
        status: 'open',
        currentPlanVersion: 1,
        taskBoundVersion: 1,
      },
    });

    const res = await runIdPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=heartbeat`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, taskId, runId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.driftAlerts).toHaveLength(1);
    expect(body.data.driftAlerts[0].severity).toBe('high');
  });
});

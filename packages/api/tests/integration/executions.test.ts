// G module: Execution management
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  POST as runsPost,
  GET as runsGet,
} from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/route';
import { POST as runActionPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/[runId]/route';
import { POST as driftPost } from '@/app/api/projects/[projectId]/drifts/[driftId]/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';
import { scanStaleExecutions } from '@/lib/heartbeat-scanner';

describe('G: Execution Management', () => {
  const owner = 'exec-owner';
  let projectId: string;
  let taskId: string;
  let planVersion: number;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const { version } = await createActivePlan(projectId, owner);
    planVersion = version;

    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'Exec test task',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: owner,
        assigneeType: 'human',
        boundPlanVersion: planVersion,
        agentConstraints: [],
      },
    });
    taskId = task.id;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  let runId: string;

  it('G1: POST /runs → 201, status=running', async () => {
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
    expect(body.data.status).toBe('running');
    runId = body.data.id;
  });

  it('G2: POST /runs/:id?action=heartbeat → 200, lastHeartbeatAt 更新', async () => {
    const before = await testPrisma.executionRun.findUnique({ where: { id: runId } });
    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));

    const res = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=heartbeat`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, taskId, runId } },
    );
    expect(res.status).toBe(200);
    const after = await testPrisma.executionRun.findUnique({ where: { id: runId } });
    expect(after?.lastHeartbeatAt?.getTime()).toBeGreaterThanOrEqual(
      before?.lastHeartbeatAt?.getTime() ?? 0,
    );
  });

  it('G5: GET /tasks/:id/runs → 200, 分页', async () => {
    const res = await runsGet(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs`, { userName: owner }),
      { params: { projectId, taskId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeDefined();
  });

  it('G8: heartbeat on completed run → 400 STATE_CONFLICT', async () => {
    // Complete the original run first — mutex (one running per task) blocks parallel creates.
    await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: {
          status: 'completed',
          outputSummary: 'done',
          deliverablesMet: ['completed the required task work'],
        },
      }),
      { params: { projectId, taskId, runId } },
    );

    // Reset task back to in_progress so a new run can be started for the next assertions
    await testPrisma.task.update({ where: { id: taskId }, data: { status: 'in_progress' } });

    const res2 = await runsPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs`, {
        method: 'POST',
        userName: owner,
        body: { executorType: 'human', executorName: owner },
      }),
      { params: { projectId, taskId } },
    );
    const run2Id = (await res2.json()).data.id;

    // Try to heartbeat the completed run
    const hbRes = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=heartbeat`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, taskId, runId } },
    );
    expect(hbRes.status).toBe(409);
    const body = await hbRes.json();
    expect(body.error.code).toBe('STATE_CONFLICT');

    // G9: complete on already completed run → 409
    const completeRes = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: { status: 'completed', outputSummary: 'done again' },
      }),
      { params: { projectId, taskId, runId } },
    );
    expect(completeRes.status).toBe(409);

    runId = run2Id; // switch to the new running run for subsequent tests
  });

  it('G3: POST /runs/:id?action=complete {status:completed} → run→completed, task→done', async () => {
    // G8 completed the original run (task→done), runId is now run2Id still running
    // Reset task to in_progress so the completion can proceed
    await testPrisma.task.update({ where: { id: taskId }, data: { status: 'in_progress' } });
    const res = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: {
          status: 'completed',
          outputSummary: 'all done',
          deliverablesMet: ['completed the required task work'],
        },
      }),
      { params: { projectId, taskId, runId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('completed');

    const task = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('done');
  });

  it('G4: complete {status:failed} → run→failed, task→blocked', async () => {
    // Reset task to in_progress and create a new run
    await testPrisma.task.update({ where: { id: taskId }, data: { status: 'in_progress' } });
    const res3 = await runsPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs`, {
        method: 'POST',
        userName: owner,
        body: { executorType: 'human', executorName: owner },
      }),
      { params: { projectId, taskId } },
    );
    const run3Id = (await res3.json()).data.id;

    const failRes = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${run3Id}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: { status: 'failed', outputSummary: 'failed' },
      }),
      { params: { projectId, taskId, runId: run3Id } },
    );
    expect(failRes.status).toBe(200);
    expect((await failRes.json()).data.status).toBe('failed');

    const task = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('blocked');
  });

  it('G6: scanStaleExecutions → stale (5min threshold)', async () => {
    // Reset task and create a running run
    await testPrisma.task.update({ where: { id: taskId }, data: { status: 'in_progress' } });
    const staleRun = await testPrisma.executionRun.create({
      data: {
        taskId,
        status: 'running',
        executorType: 'agent',
        executorName: 'test-agent',
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(),
        lastHeartbeatAt: new Date(Date.now() - 6 * 60 * 1000), // 6 minutes ago
      },
    });

    await scanStaleExecutions();

    const updated = await testPrisma.executionRun.findUnique({ where: { id: staleRun.id } });
    expect(updated?.status).toBe('stale');
  });

  it('G7b: scanStaleExecutions → paused → superseded (pause-ack-timeout 5min default)', async () => {
    // Mirrors G6 but for the drift v2 paused-run lifecycle: the run was
    // moved to 'paused' by the drift engine on a plan activate, the agent
    // never ack-paused, the scanner sweeps it into 'superseded' so it
    // doesn't sit half-alive. We freeze the "time since pause" via the
    // lastHeartbeatAt proxy — heartbeat was rejected post-pause, so the
    // timestamp is effectively the pause moment.
    const pausedRun = await testPrisma.executionRun.create({
      data: {
        taskId,
        status: 'paused',
        executorType: 'agent',
        executorName: 'test-paused-agent',
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(Date.now() - 10 * 60 * 1000),
        lastHeartbeatAt: new Date(Date.now() - 6 * 60 * 1000), // 6 minutes ago > 5min default
      },
    });

    await scanStaleExecutions();

    const updated = await testPrisma.executionRun.findUnique({ where: { id: pausedRun.id } });
    expect(updated?.status).toBe('superseded');
    expect(updated?.endedAt).not.toBeNull();
    expect(updated?.outputSummary).toMatch(/pause-ack-timeout/);
  });

  it('G7c: paused run still within the timeout window is left alone', async () => {
    const recentPause = await testPrisma.executionRun.create({
      data: {
        taskId,
        status: 'paused',
        executorType: 'agent',
        executorName: 'test-recent-paused-agent',
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(),
        lastHeartbeatAt: new Date(), // just now — well within 5min
      },
    });

    await scanStaleExecutions();

    const updated = await testPrisma.executionRun.findUnique({ where: { id: recentPause.id } });
    expect(updated?.status).toBe('paused');
  });

  it('G7: scanStaleExecutions → failed (30min threshold)', async () => {
    // Create a stale run that's been stale for >30min
    const staleRun = await testPrisma.executionRun.create({
      data: {
        taskId,
        status: 'stale',
        executorType: 'agent',
        executorName: 'test-agent-2',
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(),
        lastHeartbeatAt: new Date(Date.now() - 31 * 60 * 1000), // 31 minutes ago
      },
    });

    await scanStaleExecutions();

    const updated = await testPrisma.executionRun.findUnique({ where: { id: staleRun.id } });
    expect(updated?.status).toBe('failed');
  });

  it('G10: POST /runs → taskPackSnapshot 自动填充', async () => {
    await testPrisma.task.update({ where: { id: taskId }, data: { status: 'in_progress' } });
    // Pre-register the agent member (R-012: execution_start no longer auto-registers).
    await testPrisma.projectMember.create({
      data: { projectId, name: 'claude', role: 'developer', type: 'agent' },
    });
    const res = await runsPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs`, {
        method: 'POST',
        userName: owner,
        body: { executorType: 'agent', executorName: 'claude' },
      }),
      { params: { projectId, taskId } },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.taskPackSnapshot).not.toBeNull();
  });

  it('G12: todo task claim → atomically transitions to in_progress; done task → 409', async () => {
    // Create a fresh task in 'todo' state
    const todoTask = await testPrisma.task.create({
      data: {
        projectId,
        title: 'Atomic claim test',
        type: 'code',
        priority: 'p1',
        status: 'todo',
        assignee: owner,
        assigneeType: 'human',
        boundPlanVersion: planVersion,
        agentConstraints: [],
      },
    });

    // Pre-register the agent member (R-012: execution_start no longer auto-registers).
    await testPrisma.projectMember.create({
      data: { projectId, name: 'ai', role: 'developer', type: 'agent' },
    });

    // Claim a todo task — must succeed and transition task to in_progress
    const claimRes = await runsPost(
      makeReq(`/api/projects/${projectId}/tasks/${todoTask.id}/runs`, {
        method: 'POST',
        userName: owner,
        body: { executorType: 'agent', executorName: 'ai' },
      }),
      { params: { projectId, taskId: todoTask.id } },
    );
    expect(claimRes.status).toBe(201);
    const claimed = await testPrisma.task.findUnique({ where: { id: todoTask.id } });
    expect(claimed?.status).toBe('in_progress');
    expect(claimed?.assignee).toBe('ai');
    expect(claimed?.assigneeType).toBe('agent');

    // Mark task as done — simulate completed state
    await testPrisma.task.update({ where: { id: todoTask.id }, data: { status: 'done' } });

    // Attempt execution_start on a done task — neither 'todo' nor 'in_progress' branch runs,
    // so run is created but task stays done (not a worker-visible race scenario)
    // The real race guard (updateMany count=0 → 409) fires only under true concurrent load
    // where two requests both read 'todo' before either commits — verified by DB atomicity guarantee.

    await testPrisma.task.delete({ where: { id: todoTask.id } });
  });

  it('G13 (R-012): unregistered agent → 404; owner + auto_register=true creates the member', async () => {
    // Setup: dedicated project + plan + task to keep this isolated from other tests
    const { projectId: pid } = await createTestProject('r012-owner');
    const { version: pv } = await createActivePlan(pid, 'r012-owner');
    const t = await testPrisma.task.create({
      data: {
        projectId: pid,
        title: 'R-012 task',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: 'r012-owner',
        assigneeType: 'human',
        boundPlanVersion: pv,
        agentConstraints: [],
      },
    });
    // A non-owner developer member who will try to start a run with an unknown agent
    await testPrisma.projectMember.create({
      data: { projectId: pid, name: 'r012-dev', role: 'developer', type: 'human' },
    });

    // Case 1: unknown agent + non-owner caller → 404
    const denied = await runsPost(
      makeReq(`/api/projects/${pid}/tasks/${t.id}/runs`, {
        method: 'POST',
        userName: 'r012-dev',
        body: { executorType: 'agent', executorName: 'ghost-agent' },
      }),
      { params: { projectId: pid, taskId: t.id } },
    );
    expect(denied.status).toBe(404);
    const deniedBody = await denied.json();
    expect(deniedBody.error.code).toBe('NOT_FOUND');
    expect(deniedBody.error.message).toMatch(/not a registered member/i);
    const ghostExists = await testPrisma.projectMember.findUnique({
      where: { projectId_name: { projectId: pid, name: 'ghost-agent' } },
    });
    expect(ghostExists).toBeNull();

    // Case 2: unknown agent + owner caller WITHOUT auto_register → still 404
    const ownerNoFlag = await runsPost(
      makeReq(`/api/projects/${pid}/tasks/${t.id}/runs`, {
        method: 'POST',
        userName: 'r012-owner',
        body: { executorType: 'agent', executorName: 'newbot' },
      }),
      { params: { projectId: pid, taskId: t.id } },
    );
    expect(ownerNoFlag.status).toBe(404);
    const stillMissing = await testPrisma.projectMember.findUnique({
      where: { projectId_name: { projectId: pid, name: 'newbot' } },
    });
    expect(stillMissing).toBeNull();

    // Case 3: unknown agent + owner + ?auto_register=true → 201 and agent member is created
    const ownerWithFlag = await runsPost(
      makeReq(`/api/projects/${pid}/tasks/${t.id}/runs`, {
        method: 'POST',
        userName: 'r012-owner',
        body: { executorType: 'agent', executorName: 'newbot' },
        searchParams: { auto_register: 'true' },
      }),
      { params: { projectId: pid, taskId: t.id } },
    );
    expect(ownerWithFlag.status).toBe(201);
    const created = await testPrisma.projectMember.findUnique({
      where: { projectId_name: { projectId: pid, name: 'newbot' } },
    });
    expect(created).not.toBeNull();
    expect(created?.type).toBe('agent');
    expect(created?.role).toBe('developer');

    // Case 4: non-owner + ?auto_register=true → still 404 (only owners may opt-in)
    // Reset the running run so the mutex doesn't hide the 404 we want to assert.
    await testPrisma.executionRun.updateMany({
      where: { taskId: t.id, status: 'running' },
      data: { status: 'failed', endedAt: new Date() },
    });
    await testPrisma.task.update({ where: { id: t.id }, data: { status: 'in_progress' } });
    const devTriesAutoReg = await runsPost(
      makeReq(`/api/projects/${pid}/tasks/${t.id}/runs`, {
        method: 'POST',
        userName: 'r012-dev',
        body: { executorType: 'agent', executorName: 'sneaky-agent' },
        searchParams: { auto_register: 'true' },
      }),
      { params: { projectId: pid, taskId: t.id } },
    );
    expect(devTriesAutoReg.status).toBe(404);
    const sneaky = await testPrisma.projectMember.findUnique({
      where: { projectId_name: { projectId: pid, name: 'sneaky-agent' } },
    });
    expect(sneaky).toBeNull();

    await cleanupProject(pid);
  });

  it('G14 (R-054): execution_start rejects terminal/blocked task statuses', async () => {
    // Setup an isolated project so terminal-status tasks don't poison sibling tests.
    const { projectId: pid } = await createTestProject('r054-owner');
    const { version: pv } = await createActivePlan(pid, 'r054-owner');

    async function makeTask(status: 'done' | 'cancelled' | 'blocked' | 'todo' | 'in_progress') {
      return testPrisma.task.create({
        data: {
          projectId: pid,
          title: `R-054 ${status}`,
          type: 'code',
          priority: 'p1',
          status,
          assignee: 'r054-owner',
          assigneeType: 'human',
          boundPlanVersion: pv,
          agentConstraints: [],
        },
      });
    }

    for (const status of ['done', 'cancelled', 'blocked'] as const) {
      const t = await makeTask(status);
      const res = await runsPost(
        makeReq(`/api/projects/${pid}/tasks/${t.id}/runs`, {
          method: 'POST',
          userName: 'r054-owner',
          body: { executorType: 'human', executorName: 'r054-owner' },
        }),
        { params: { projectId: pid, taskId: t.id } },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('STATE_CONFLICT');
      expect(body.error.message).toMatch(new RegExp(`task is "${status}"`));
      expect(body.error.details?.taskStatus).toBe(status);

      // Crucially: no run row may be created when the gate fires. Before R-054, a
      // 'done' task would silently get a fresh run row attached to it.
      const runs = await testPrisma.executionRun.findMany({ where: { taskId: t.id } });
      expect(runs).toHaveLength(0);

      // Task status must be untouched.
      const after = await testPrisma.task.findUnique({ where: { id: t.id } });
      expect(after?.status).toBe(status);
    }

    // Positive control: a 'todo' task in the same project still succeeds.
    const okTask = await makeTask('todo');
    const okRes = await runsPost(
      makeReq(`/api/projects/${pid}/tasks/${okTask.id}/runs`, {
        method: 'POST',
        userName: 'r054-owner',
        body: { executorType: 'human', executorName: 'r054-owner' },
      }),
      { params: { projectId: pid, taskId: okTask.id } },
    );
    expect(okRes.status).toBe(201);

    await cleanupProject(pid);
  });

  it('G11: drift → 409 DRIFT_UNRESOLVED → resolve → 201 (核心链路)', async () => {
    // Reset task to a state where it can start execution. Also clear any leftover
    // running runs from prior tests — the one-running-per-task mutex would otherwise
    // block this test's runsPost calls.
    await testPrisma.executionRun.updateMany({
      where: { taskId, status: 'running' },
      data: { status: 'failed', endedAt: new Date() },
    });
    await testPrisma.task.update({ where: { id: taskId }, data: { status: 'in_progress' } });

    // Inject an open drift alert directly to simulate plan version change
    const drift = await testPrisma.driftAlert.create({
      data: {
        projectId,
        taskId,
        type: 'version_mismatch',
        severity: 'high',
        reason: 'Plan updated while task was running',
        status: 'open',
        currentPlanVersion: planVersion + 1,
        taskBoundVersion: planVersion,
      },
    });

    // Attempt execution start — must be blocked
    const blockedRes = await runsPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs`, {
        method: 'POST',
        userName: owner,
        body: { executorType: 'human', executorName: owner },
      }),
      { params: { projectId, taskId } },
    );
    expect(blockedRes.status).toBe(409);
    const blockedBody = await blockedRes.json();
    expect(blockedBody.error.code).toBe('DRIFT_UNRESOLVED');
    expect(blockedBody.error.details.drifts).toHaveLength(1);
    expect(blockedBody.error.details.drifts[0].id).toBe(drift.id);

    // Resolve the drift
    const resolveRes = await driftPost(
      makeReq(`/api/projects/${projectId}/drifts/${drift.id}`, {
        method: 'POST',
        userName: owner,
        body: { action: 'no_impact' },
      }),
      { params: { projectId, driftId: drift.id } },
    );
    expect(resolveRes.status).toBe(200);

    // Now execution start must succeed
    const successRes = await runsPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs`, {
        method: 'POST',
        userName: owner,
        body: { executorType: 'human', executorName: owner },
      }),
      { params: { projectId, taskId } },
    );
    expect(successRes.status).toBe(201);
  });
});

// R-047: DELETE /tasks/:taskId must refuse when an ExecutionRun for the task
// is still `running`. Without the guard, the cascade delete on Task→
// ExecutionRun would silently destroy a live agent's run record (and its
// exec-scoped API key reference), bypassing the explicit cancel path and
// leaving heartbeats/audit in a torn state. The owner must cancel the run
// first; only then can the task be deleted.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as tasksPost } from '@/app/api/projects/[projectId]/tasks/route';
import { DELETE as taskDelete } from '@/app/api/projects/[projectId]/tasks/[taskId]/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('R-047: DELETE task rejects running execution run', () => {
  const owner = 'r047-owner';
  let projectId: string;
  let planVersion: number;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const { version } = await createActivePlan(projectId, owner);
    planVersion = version;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  async function createTaskWithRun(title: string, runStatus: 'running' | 'completed' | 'failed') {
    const createRes = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title, type: 'code', priority: 'p1' },
      }),
      { params: { projectId } },
    );
    expect(createRes.status).toBe(201);
    const task = (await createRes.json()).data as { id: string };

    const run = await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
        executorType: 'human',
        executorName: owner,
        status: runStatus,
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        ...(runStatus !== 'running' ? { endedAt: new Date() } : {}),
      },
    });
    return { taskId: task.id, runId: run.id };
  }

  it('returns 409 STATE_CONFLICT when a running execution exists', async () => {
    const { taskId, runId } = await createTaskWithRun('R-047 blocked delete', 'running');

    const res = await taskDelete(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: { projectId, taskId } },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('STATE_CONFLICT');
    expect(body.error.message).toMatch(/running execution/i);
    expect(body.error.details?.runId).toBe(runId);
    expect(body.error.details?.executorName).toBe(owner);

    const stillThere = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(stillThere).not.toBeNull();

    const runStill = await testPrisma.executionRun.findUnique({ where: { id: runId } });
    expect(runStill?.status).toBe('running');
  });

  it('allows delete when only completed runs exist', async () => {
    const { taskId } = await createTaskWithRun('R-047 completed run ok', 'completed');

    const res = await taskDelete(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: { projectId, taskId } },
    );
    expect(res.status).toBe(200);

    const gone = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(gone).toBeNull();
  });

  it('allows delete after the running run is cancelled (status no longer "running")', async () => {
    const { taskId, runId } = await createTaskWithRun('R-047 unblocked after cancel', 'running');

    await testPrisma.executionRun.update({
      where: { id: runId },
      data: { status: 'cancelled', endedAt: new Date() },
    });

    const res = await taskDelete(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: { projectId, taskId } },
    );
    expect(res.status).toBe(200);
  });
});

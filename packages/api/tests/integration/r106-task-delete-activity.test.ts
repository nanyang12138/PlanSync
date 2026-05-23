// R-106: task DELETE 写 activity
//
// DELETE /projects/:projectId/tasks/:taskId is the most destructive
// mutation on the task surface — an owner removing a task today leaves
// no trace in the activity feed, so a member cannot reconstruct why a
// task disappeared from the board. R-105 closed this hole for PATCH
// (status / assignee edits); R-106 does the same for DELETE.
//
// This test asserts that:
//   1. A successful DELETE writes exactly one `task_deleted` activity
//      whose metadata captures the pre-delete snapshot (title, status,
//      assignee, assigneeType, boundPlanVersion, taskId) and whose
//      actorName matches the caller.
//   2. A DELETE that fails because a running ExecutionRun blocks it
//      (R-047 gate) writes NO activity row — we only audit on success
//      so the feed reflects what actually happened.
//   3. A DELETE that fails because the task does not exist in this
//      project (404) writes no activity either.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as tasksPost } from '@/app/api/projects/[projectId]/tasks/route';
import { DELETE as taskDelete } from '@/app/api/projects/[projectId]/tasks/[taskId]/route';
import {
  makeReq,
  createTestProject,
  addMember,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('R-106: task DELETE writes activity', () => {
  const owner = 'r106-owner';
  const dev = 'r106-dev';
  let projectId: string;
  let planVersion: number;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, dev);
    const { version } = await createActivePlan(projectId, owner);
    planVersion = version;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  async function createTask(opts?: { assignee?: string; title?: string }): Promise<string> {
    const title = opts?.title ?? `R106 task ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const res = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: {
          title,
          type: 'code',
          assignee: opts?.assignee,
          assigneeType: opts?.assignee ? 'human' : undefined,
        },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(201);
    return (await res.json()).data.id;
  }

  it('successful DELETE writes a task_deleted activity with the pre-delete snapshot', async () => {
    const title = `R106 success ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const taskId = await createTask({ assignee: dev, title });

    const before = await testPrisma.activity.count({
      where: { projectId, type: 'task_deleted' },
    });

    const res = await taskDelete(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: { projectId, taskId } },
    );
    expect(res.status).toBe(200);

    const after = await testPrisma.activity.findMany({
      where: { projectId, type: 'task_deleted' },
      orderBy: { createdAt: 'desc' },
    });
    expect(after.length).toBe(before + 1);

    const activity = after[0];
    expect(activity.actorName).toBe(owner);
    expect(activity.actorType).toBe('human');
    expect(activity.summary).toContain(title);
    expect(activity.summary).toContain('deleted');

    const md = activity.metadata as {
      taskId?: string;
      title?: string;
      status?: string;
      assignee?: string | null;
      assigneeType?: string;
      boundPlanVersion?: number;
    } | null;
    expect(md?.taskId).toBe(taskId);
    expect(md?.title).toBe(title);
    expect(md?.status).toBe('todo');
    expect(md?.assignee).toBe(dev);
    expect(md?.assigneeType).toBe('human');
    expect(md?.boundPlanVersion).toBe(planVersion);

    const gone = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(gone).toBeNull();
  });

  it('DELETE blocked by a running execution writes NO task_deleted activity', async () => {
    const taskId = await createTask({ title: `R106 blocked ${Date.now()}` });

    const run = await testPrisma.executionRun.create({
      data: {
        taskId,
        executorType: 'human',
        executorName: owner,
        status: 'running',
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    });

    const before = await testPrisma.activity.count({
      where: { projectId, type: 'task_deleted' },
    });

    const res = await taskDelete(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: { projectId, taskId } },
    );
    expect(res.status).toBe(409);

    const after = await testPrisma.activity.count({
      where: { projectId, type: 'task_deleted' },
    });
    expect(after).toBe(before);

    const stillThere = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(stillThere).not.toBeNull();

    await testPrisma.executionRun.update({
      where: { id: run.id },
      data: { status: 'cancelled', endedAt: new Date() },
    });
  });

  it('DELETE of a non-existent task writes no activity', async () => {
    const before = await testPrisma.activity.count({
      where: { projectId, type: 'task_deleted' },
    });

    const res = await taskDelete(
      makeReq(`/api/projects/${projectId}/tasks/does-not-exist`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: { projectId, taskId: 'does-not-exist' } },
    );
    expect(res.status).toBe(404);

    const after = await testPrisma.activity.count({
      where: { projectId, type: 'task_deleted' },
    });
    expect(after).toBe(before);
  });
});

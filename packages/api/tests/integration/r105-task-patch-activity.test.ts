// R-105: task PATCH 写 activity
//
// The PATCH /projects/:projectId/tasks/:taskId endpoint is the canonical
// surface for status flips and reassignments outside the execution-run
// flow (claim / complete-human / execution_complete each write their own
// activity rows). Before R-105 a PATCH that flipped status (e.g.
// in_progress → blocked) or moved an assignee from one member to another
// produced no activity row, hiding accountability for those edits from
// the audit feed.
//
// This test asserts that:
//   1. status PATCH (todo → in_progress) writes a `task_status_changed`
//      activity with fromStatus/toStatus metadata;
//   2. assignee PATCH (member A → member B) writes a `task_reassigned`
//      activity with fromAssignee/toAssignee metadata;
//   3. unassign (assignee → null) writes `task_reassigned` with
//      toAssignee: null and a summary that names the previous holder;
//   4. a PATCH that touches neither field (e.g. title only) writes
//      neither activity type — we only audit what actually changed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as tasksPost } from '@/app/api/projects/[projectId]/tasks/route';
import { PATCH as taskPatch } from '@/app/api/projects/[projectId]/tasks/[taskId]/route';
import {
  makeReq,
  createTestProject,
  addMember,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('R-105: task PATCH writes activity', () => {
  const owner = 'r105-owner';
  const devA = 'r105-dev-a';
  const devB = 'r105-dev-b';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, devA);
    await addMember(projectId, devB);
    await createActivePlan(projectId, owner);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  async function createTask(assignee?: string): Promise<string> {
    const res = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: {
          title: `R105 task ${Date.now()}-${Math.random().toString(36).slice(2)}`,
          type: 'code',
          assignee,
          assigneeType: assignee ? 'human' : undefined,
        },
      }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(res.status).toBe(201);
    return (await res.json()).data.id;
  }

  it('status flip todo→in_progress writes task_status_changed activity', async () => {
    const taskId = await createTask(devA);

    const before = await testPrisma.activity.count({
      where: { projectId, type: 'task_status_changed' },
    });

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}`, {
        method: 'PATCH',
        userName: owner,
        body: { status: 'in_progress' },
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );
    expect(res.status).toBe(200);

    const after = await testPrisma.activity.findMany({
      where: { projectId, type: 'task_status_changed' },
      orderBy: { createdAt: 'desc' },
    });
    expect(after.length).toBe(before + 1);

    const activity = after[0];
    expect(activity.actorName).toBe(owner);
    expect(activity.actorType).toBe('human');
    expect(activity.summary).toContain('todo');
    expect(activity.summary).toContain('in_progress');

    const md = activity.metadata as {
      taskId?: string;
      fromStatus?: string;
      toStatus?: string;
    } | null;
    expect(md?.taskId).toBe(taskId);
    expect(md?.fromStatus).toBe('todo');
    expect(md?.toStatus).toBe('in_progress');
  });

  it('assignee swap devA→devB writes task_reassigned activity', async () => {
    const taskId = await createTask(devA);

    const before = await testPrisma.activity.count({
      where: { projectId, type: 'task_reassigned' },
    });

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}`, {
        method: 'PATCH',
        userName: owner,
        body: { assignee: devB },
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );
    expect(res.status).toBe(200);

    const after = await testPrisma.activity.findMany({
      where: { projectId, type: 'task_reassigned' },
      orderBy: { createdAt: 'desc' },
    });
    expect(after.length).toBe(before + 1);

    const activity = after[0];
    expect(activity.actorName).toBe(owner);
    expect(activity.summary).toContain(devA);
    expect(activity.summary).toContain(devB);

    const md = activity.metadata as {
      taskId?: string;
      fromAssignee?: string | null;
      toAssignee?: string | null;
    } | null;
    expect(md?.taskId).toBe(taskId);
    expect(md?.fromAssignee).toBe(devA);
    expect(md?.toAssignee).toBe(devB);
  });

  it('unassign (assignee→null) writes task_reassigned with toAssignee=null', async () => {
    const taskId = await createTask(devA);

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}`, {
        method: 'PATCH',
        userName: owner,
        body: { assignee: null },
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );
    expect(res.status).toBe(200);

    const activity = await testPrisma.activity.findFirst({
      where: { projectId, type: 'task_reassigned' },
      orderBy: { createdAt: 'desc' },
    });
    expect(activity).not.toBeNull();
    const md = activity!.metadata as {
      taskId?: string;
      fromAssignee?: string | null;
      toAssignee?: string | null;
    } | null;
    expect(md?.taskId).toBe(taskId);
    expect(md?.fromAssignee).toBe(devA);
    expect(md?.toAssignee).toBeNull();
    expect(activity!.summary).toContain('unassigned');
    expect(activity!.summary).toContain(devA);
  });

  it('PATCH that touches only title writes no status / reassign activity', async () => {
    const taskId = await createTask(devA);

    const statusBefore = await testPrisma.activity.count({
      where: { projectId, type: 'task_status_changed' },
    });
    const reassignBefore = await testPrisma.activity.count({
      where: { projectId, type: 'task_reassigned' },
    });

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}`, {
        method: 'PATCH',
        userName: owner,
        body: { title: 'renamed-by-owner' },
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );
    expect(res.status).toBe(200);

    const statusAfter = await testPrisma.activity.count({
      where: { projectId, type: 'task_status_changed' },
    });
    const reassignAfter = await testPrisma.activity.count({
      where: { projectId, type: 'task_reassigned' },
    });

    expect(statusAfter).toBe(statusBefore);
    expect(reassignAfter).toBe(reassignBefore);
  });
});

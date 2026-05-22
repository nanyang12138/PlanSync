// R-135: task-pack must verify task↔project ownership and refuse to leak
// task title / agentContext / expectedOutput / plan content across projects.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Email is mocked so plan/task activity does not try to send real mail.
vi.mock('@/lib/email', () => ({
  sendMail: vi.fn(),
  userEmail: (name: string) => `${name}@example.com`,
}));

import { GET as packGet } from '@/app/api/projects/[projectId]/tasks/[taskId]/pack/route';
import { GET as taskGet } from '@/app/api/projects/[projectId]/tasks/[taskId]/route';
import { POST as runsPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/route';
import { buildTaskPack } from '@/lib/task-pack';
import {
  makeReq,
  createTestProject,
  cleanupProject,
  createActivePlan,
  testPrisma,
} from '../helpers/request';

describe('R-135: task-pack cross-project isolation', () => {
  const ownerA = 'r135-owner-a';
  const ownerB = 'r135-owner-b';
  let projectAId: string;
  let projectBId: string;
  let taskBId: string;
  let planBVersion: number;

  beforeAll(async () => {
    ({ projectId: projectAId } = await createTestProject(ownerA));
    ({ projectId: projectBId } = await createTestProject(ownerB));

    const planB = await createActivePlan(projectBId, ownerB);
    planBVersion = planB.version;

    const task = await testPrisma.task.create({
      data: {
        projectId: projectBId,
        title: 'Secret B task',
        description: 'Should not be visible from project A',
        type: 'code',
        priority: 'p1',
        status: 'todo',
        assignee: ownerB,
        assigneeType: 'human',
        boundPlanVersion: planBVersion,
        agentConstraints: [],
        agentContext: 'B-only context with sensitive notes',
        expectedOutput: 'B-only expected output',
      },
    });
    taskBId = task.id;
  });

  afterAll(async () => {
    await cleanupProject(projectAId);
    await cleanupProject(projectBId);
  });

  // V1 — buildTaskPack itself refuses the cross-project lookup.
  it('buildTaskPack returns null when projectId does not own the task', async () => {
    const pack = await buildTaskPack(taskBId, projectAId);
    expect(pack).toBeNull();
  });

  // V2 — buildTaskPack with the right (taskId, projectId) pair still works.
  it('buildTaskPack returns the pack for the owning project', async () => {
    const pack = await buildTaskPack(taskBId, projectBId);
    expect(pack).not.toBeNull();
    expect(pack!.task.id).toBe(taskBId);
    expect(pack!.task.title).toBe('Secret B task');
    expect(pack!.project?.id).toBe(projectBId);
    expect(pack!.plan?.version).toBe(planBVersion);
  });

  // V3 — the GET /pack route returns 404 when called from project A with
  // project B's taskId, even though the caller is authorized for A.
  it('GET /projects/A/tasks/{taskB}/pack → 404, no payload leaks', async () => {
    const res = await packGet(
      makeReq(`/api/projects/${projectAId}/tasks/${taskBId}/pack`, { userName: ownerA }),
      { params: { projectId: projectAId, taskId: taskBId } },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    // The error envelope must not echo the secret task fields.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('Secret B task');
    expect(serialized).not.toContain('B-only context');
    expect(serialized).not.toContain('B-only expected output');
  });

  // V4 — the GET /task route is also locked down (defense in depth).
  it('GET /projects/A/tasks/{taskB} → 404', async () => {
    const res = await taskGet(
      makeReq(`/api/projects/${projectAId}/tasks/${taskBId}`, { userName: ownerA }),
      { params: { projectId: projectAId, taskId: taskBId } },
    );
    expect(res.status).toBe(404);
  });

  // V5 — execution_start cannot be invoked against a task in another project.
  it('POST /projects/A/tasks/{taskB}/runs → 404', async () => {
    const res = await runsPost(
      makeReq(`/api/projects/${projectAId}/tasks/${taskBId}/runs`, {
        method: 'POST',
        userName: ownerA,
        body: { executorType: 'human', executorName: ownerA },
      }),
      { params: { projectId: projectAId, taskId: taskBId } },
    );
    expect(res.status).toBe(404);
  });

  // V6 — the same task fetched through the correct project still works.
  it('GET /projects/B/tasks/{taskB}/pack → 200 with full payload', async () => {
    const res = await packGet(
      makeReq(`/api/projects/${projectBId}/tasks/${taskBId}/pack`, { userName: ownerB }),
      { params: { projectId: projectBId, taskId: taskBId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.task.id).toBe(taskBId);
    expect(body.data.task.title).toBe('Secret B task');
  });
});

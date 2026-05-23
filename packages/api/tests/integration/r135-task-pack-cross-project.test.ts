// R-135: task-pack must verify task↔project ownership and refuse to leak
// task title / agentContext / expectedOutput / plan content across projects.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Email is mocked so plan/task activity does not try to send real mail.
vi.mock('@/lib/email', () => ({
  sendMail: vi.fn(),
  userEmail: (name: string) => `${name}@example.com`,
}));

// #255/#256: spy on the audit logger so we can assert that every
// cross-project rejection on read AND write paths emits the
// suspectCrossProject signal. vi.hoisted so the spy is initialised
// before vi.mock's hoisted factory runs.
const { loggerWarn } = vi.hoisted(() => ({ loggerWarn: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: {
    warn: loggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { GET as packGet } from '@/app/api/projects/[projectId]/tasks/[taskId]/pack/route';
import {
  GET as taskGet,
  PATCH as taskPatch,
  DELETE as taskDelete,
} from '@/app/api/projects/[projectId]/tasks/[taskId]/route';
import { POST as runsPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/route';
import { POST as claimPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/claim/route';
import { POST as declinePost } from '@/app/api/projects/[projectId]/tasks/[taskId]/decline/route';
import { POST as rebindPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/rebind/route';
import { POST as completeHumanPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/complete-human/route';
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

  // ---- #255 / #256: every cross-project route must emit the audit signal ----

  function lastSuspectCrossProjectCall(): {
    suspectCrossProject?: boolean;
    callContext?: string;
    requestedProjectId?: string;
    actualProjectId?: string;
    taskId?: string;
  } | null {
    for (let i = loggerWarn.mock.calls.length - 1; i >= 0; i -= 1) {
      const arg = loggerWarn.mock.calls[i][0];
      if (typeof arg === 'object' && arg !== null && 'suspectCrossProject' in arg) {
        return arg as Record<string, unknown>;
      }
    }
    return null;
  }

  function clearWarn() {
    loggerWarn.mockClear();
  }

  it('#255: GET /pack cross-project miss emits suspectCrossProject audit', async () => {
    clearWarn();
    await packGet(
      makeReq(`/api/projects/${projectAId}/tasks/${taskBId}/pack`, { userName: ownerA }),
      { params: { projectId: projectAId, taskId: taskBId } },
    );
    const audit = lastSuspectCrossProjectCall();
    expect(audit?.suspectCrossProject).toBe(true);
    expect(audit?.callContext).toBe('GET /pack');
    expect(audit?.actualProjectId).toBe(projectBId);
    expect(audit?.requestedProjectId).toBe(projectAId);
  });

  // #256: every write path emits the same audit signal so a multi-route
  // probe sequence (PATCH then DELETE then claim ...) is fully traceable.
  const writeProbes: Array<{ name: string; run: () => Promise<unknown>; ctx: string }> = [
    {
      name: 'PATCH /tasks/:id',
      ctx: 'PATCH /tasks/:id',
      run: () =>
        taskPatch(
          makeReq(`/api/projects/${projectAId}/tasks/${taskBId}`, {
            method: 'PATCH',
            userName: ownerA,
            body: { description: 'leak attempt' },
          }),
          { params: { projectId: projectAId, taskId: taskBId } },
        ),
    },
    {
      name: 'DELETE /tasks/:id',
      ctx: 'DELETE /tasks/:id',
      run: () =>
        taskDelete(
          makeReq(`/api/projects/${projectAId}/tasks/${taskBId}`, {
            method: 'DELETE',
            userName: ownerA,
          }),
          { params: { projectId: projectAId, taskId: taskBId } },
        ),
    },
    {
      name: 'POST /tasks/:id/claim',
      ctx: 'POST /tasks/:id/claim',
      run: () =>
        claimPost(
          makeReq(`/api/projects/${projectAId}/tasks/${taskBId}/claim`, {
            method: 'POST',
            userName: ownerA,
            body: { assignee: ownerA },
          }),
          { params: { projectId: projectAId, taskId: taskBId } },
        ),
    },
    {
      name: 'POST /tasks/:id/decline',
      ctx: 'POST /tasks/:id/decline',
      run: () =>
        declinePost(
          makeReq(`/api/projects/${projectAId}/tasks/${taskBId}/decline`, {
            method: 'POST',
            userName: ownerA,
          }),
          { params: { projectId: projectAId, taskId: taskBId } },
        ),
    },
    {
      name: 'POST /tasks/:id/rebind',
      ctx: 'POST /tasks/:id/rebind',
      run: () =>
        rebindPost(
          makeReq(`/api/projects/${projectAId}/tasks/${taskBId}/rebind`, {
            method: 'POST',
            userName: ownerA,
          }),
          { params: { projectId: projectAId, taskId: taskBId } },
        ),
    },
    {
      name: 'POST /tasks/:id/complete-human',
      ctx: 'POST /tasks/:id/complete-human',
      run: () =>
        completeHumanPost(
          makeReq(`/api/projects/${projectAId}/tasks/${taskBId}/complete-human`, {
            method: 'POST',
            userName: ownerA,
            body: { completionNote: 'try' },
          }),
          { params: { projectId: projectAId, taskId: taskBId } },
        ),
    },
    {
      name: 'POST /tasks/:id/runs',
      ctx: 'POST /tasks/:id/runs',
      run: () =>
        runsPost(
          makeReq(`/api/projects/${projectAId}/tasks/${taskBId}/runs`, {
            method: 'POST',
            userName: ownerA,
            body: { executorType: 'human', executorName: ownerA },
          }),
          { params: { projectId: projectAId, taskId: taskBId } },
        ),
    },
  ];

  for (const probe of writeProbes) {
    it(`#256: ${probe.name} cross-project miss emits suspectCrossProject audit`, async () => {
      clearWarn();
      const res = (await probe.run()) as Response;
      // All probes must 4xx — never confirm task existence cross-project.
      expect([403, 404]).toContain(res.status);
      const audit = lastSuspectCrossProjectCall();
      expect(audit?.suspectCrossProject).toBe(true);
      expect(audit?.callContext).toBe(probe.ctx);
      expect(audit?.actualProjectId).toBe(projectBId);
      expect(audit?.requestedProjectId).toBe(projectAId);
    });
  }
});

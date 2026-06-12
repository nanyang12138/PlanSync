// Regression: POST /tasks/:id/rebind must enforce the same owner-or-assignee
// identity gate as drift_resolve (action=rebind). The rebind route is the thin
// shortcut for that resolution and performs the same destructive writes (reset
// to `todo`, supersede in-flight runs, resolve open drift alerts) — but it
// previously only required project membership. Any developer could therefore
// blow away another member's running execution and silently clear their drift
// alerts, defeating the drift-protection guarantee.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as rebindPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/rebind/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  addMember,
  testPrisma,
} from '../helpers/request';

describe('rebind route authorization (owner or assignee only)', () => {
  const owner = 'rebind-authz-owner';
  const assignee = 'rebind-authz-assignee';
  const intruder = 'rebind-authz-intruder';
  let projectId: string;
  let v1: number;
  let v2: number;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, assignee, 'developer');
    await addMember(projectId, intruder, 'developer');
    // Two activations so the active plan is v2 and a task bound to v1 actually
    // has something to rebind to (the route 409s if already on the active one).
    ({ version: v1 } = await createActivePlan(projectId, owner));
    ({ version: v2 } = await createActivePlan(projectId, owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  async function makeTaskBoundToV1() {
    return testPrisma.task.create({
      data: {
        projectId,
        title: 'Assignee task',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee,
        assigneeType: 'human',
        boundPlanVersion: v1,
        agentConstraints: [],
      },
    });
  }

  function rebind(taskId: string, userName: string) {
    return rebindPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/rebind`, {
        method: 'POST',
        userName,
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );
  }

  it('rejects a developer who is neither owner nor assignee with 403', async () => {
    const task = await makeTaskBoundToV1();
    const res = await rebind(task.id, intruder);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');

    // None of rebind's destructive side effects must have fired.
    const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(refreshed?.status).toBe('in_progress');
    expect(refreshed?.boundPlanVersion).toBe(v1);
  });

  it('allows the task assignee to rebind to the active version', async () => {
    const task = await makeTaskBoundToV1();
    const res = await rebind(task.id, assignee);

    expect(res.status).toBe(200);
    const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(refreshed?.boundPlanVersion).toBe(v2);
    expect(refreshed?.status).toBe('todo');
  });

  it('allows the project owner to rebind any task', async () => {
    const task = await makeTaskBoundToV1();
    const res = await rebind(task.id, owner);

    expect(res.status).toBe(200);
    const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(refreshed?.boundPlanVersion).toBe(v2);
  });
});

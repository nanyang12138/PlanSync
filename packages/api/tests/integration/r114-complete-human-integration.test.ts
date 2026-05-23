// R-114: Comprehensive integration tests for the complete-human endpoint.
//
// R-046 already covers the open-drift gate; this suite covers everything else:
// authorization, task scope, state transitions, schema validation, owner
// override, prUrl persistence, activity audit, and cross-project isolation
// (R-135). The R-046 drift-gate path is intentionally not duplicated here.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as completeHumanPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/complete-human/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  addMember,
  testPrisma,
} from '../helpers/request';

describe('R-114: complete-human integration', () => {
  const owner = 'r114-owner';
  const assignee = 'r114-assignee';
  const stranger = 'r114-stranger';
  let projectId: string;
  let planVersion: number;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, assignee, 'developer');
    await addMember(projectId, stranger, 'developer');
    const { version } = await createActivePlan(projectId, owner);
    planVersion = version;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  async function makeHumanTask(overrides: {
    title: string;
    status?: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
    assignee?: string | null;
    assigneeType?: 'human' | 'agent' | 'unassigned';
  }) {
    return testPrisma.task.create({
      data: {
        projectId,
        title: overrides.title,
        type: 'code',
        priority: 'p1',
        status: overrides.status ?? 'in_progress',
        assignee: overrides.assignee === undefined ? assignee : overrides.assignee,
        assigneeType: overrides.assigneeType ?? 'human',
        boundPlanVersion: planVersion,
        agentConstraints: [],
      },
    });
  }

  it('marks the task done, records a completed run, and writes a task_completed activity', async () => {
    const task = await makeHumanTask({ title: 'happy path' });
    const activitiesBefore = await testPrisma.activity.count({
      where: { projectId, type: 'task_completed' },
    });

    const res = await completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/complete-human`, {
        method: 'POST',
        userName: assignee,
        body: {
          completionNote: 'Implemented the change and verified locally',
          prUrl: 'https://github.com/example/repo/pull/42',
        },
      }),
      { params: { projectId, taskId: task.id } },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.success).toBe(true);

    const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(refreshed?.status).toBe('done');
    expect(refreshed?.prUrl).toBe('https://github.com/example/repo/pull/42');

    const runs = await testPrisma.executionRun.findMany({ where: { taskId: task.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].executorType).toBe('human');
    expect(runs[0].executorName).toBe(assignee);
    expect(runs[0].outputSummary).toBe('Implemented the change and verified locally');
    expect(runs[0].endedAt).not.toBeNull();
    expect(runs[0].boundPlanVersion).toBe(planVersion);

    const activitiesAfter = await testPrisma.activity.count({
      where: { projectId, type: 'task_completed' },
    });
    expect(activitiesAfter).toBe(activitiesBefore + 1);
  });

  it('does not overwrite prUrl when the field is omitted', async () => {
    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'preserves existing pr url',
        type: 'code',
        priority: 'p2',
        status: 'in_progress',
        assignee,
        assigneeType: 'human',
        boundPlanVersion: planVersion,
        agentConstraints: [],
        prUrl: 'https://github.com/example/repo/pull/7',
      },
    });

    const res = await completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/complete-human`, {
        method: 'POST',
        userName: assignee,
        body: { completionNote: 'done, PR already linked' },
      }),
      { params: { projectId, taskId: task.id } },
    );

    expect(res.status).toBe(200);
    const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(refreshed?.status).toBe('done');
    expect(refreshed?.prUrl).toBe('https://github.com/example/repo/pull/7');
  });

  it('allows completing a task that is still in todo (claimed but not started)', async () => {
    const task = await makeHumanTask({ title: 'todo direct complete', status: 'todo' });

    const res = await completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/complete-human`, {
        method: 'POST',
        userName: assignee,
        body: { completionNote: 'trivial doc fix' },
      }),
      { params: { projectId, taskId: task.id } },
    );

    expect(res.status).toBe(200);
    const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(refreshed?.status).toBe('done');
  });

  it('rejects agent-assigned tasks (must use execution_complete)', async () => {
    const task = await makeHumanTask({
      title: 'agent task',
      assigneeType: 'agent',
      assignee: 'some-agent',
    });

    const res = await completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/complete-human`, {
        method: 'POST',
        userName: owner,
        body: { completionNote: 'should be blocked' },
      }),
      { params: { projectId, taskId: task.id } },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toMatch(/execution_complete/);

    const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(refreshed?.status).toBe('in_progress');
  });

  it('rejects unclaimed tasks (no assignee)', async () => {
    const task = await makeHumanTask({
      title: 'unclaimed',
      assignee: null,
      assigneeType: 'unassigned',
    });

    const res = await completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/complete-human`, {
        method: 'POST',
        userName: owner,
        body: { completionNote: 'attempt to complete unclaimed' },
      }),
      { params: { projectId, taskId: task.id } },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('STATE_CONFLICT');
    expect(body.error.message).toMatch(/claimed/i);
  });

  it('rejects tasks that are already done', async () => {
    const task = await makeHumanTask({ title: 'already done', status: 'done' });

    const res = await completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/complete-human`, {
        method: 'POST',
        userName: assignee,
        body: { completionNote: 'second time' },
      }),
      { params: { projectId, taskId: task.id } },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('STATE_CONFLICT');
    expect(body.error.message).toMatch(/in_progress or todo/);
  });

  it('rejects tasks that are blocked or cancelled', async () => {
    for (const status of ['blocked', 'cancelled'] as const) {
      const task = await makeHumanTask({ title: `status ${status}`, status });
      const res = await completeHumanPost(
        makeReq(`/api/projects/${projectId}/tasks/${task.id}/complete-human`, {
          method: 'POST',
          userName: assignee,
          body: { completionNote: `tried while ${status}` },
        }),
        { params: { projectId, taskId: task.id } },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('STATE_CONFLICT');
    }
  });

  it('rejects when an active execution run is in flight on the task', async () => {
    const task = await makeHumanTask({ title: 'has running run' });
    await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
        executorType: 'agent',
        executorName: 'some-agent',
        boundPlanVersion: planVersion,
        status: 'running',
        lastHeartbeatAt: new Date(),
        taskPackSnapshot: {},
      },
    });

    const res = await completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/complete-human`, {
        method: 'POST',
        userName: assignee,
        body: { completionNote: 'racing the run' },
      }),
      { params: { projectId, taskId: task.id } },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('STATE_CONFLICT');
    expect(body.error.message).toMatch(/active execution/i);
  });

  it('rejects callers that are neither the assignee nor a project owner', async () => {
    const task = await makeHumanTask({ title: 'wrong caller' });

    const res = await completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/complete-human`, {
        method: 'POST',
        userName: stranger,
        body: { completionNote: 'sneaky complete' },
      }),
      { params: { projectId, taskId: task.id } },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');

    const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(refreshed?.status).toBe('in_progress');

    const runs = await testPrisma.executionRun.count({ where: { taskId: task.id } });
    expect(runs).toBe(0);
  });

  it('allows a project owner to complete a task assigned to someone else', async () => {
    const task = await makeHumanTask({ title: 'owner override' });

    const res = await completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/complete-human`, {
        method: 'POST',
        userName: owner,
        body: { completionNote: 'closing on behalf of teammate' },
      }),
      { params: { projectId, taskId: task.id } },
    );

    expect(res.status).toBe(200);
    const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(refreshed?.status).toBe('done');

    const runs = await testPrisma.executionRun.findMany({ where: { taskId: task.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0].executorName).toBe(owner);
  });

  it('returns 404 when the taskId belongs to a different project (R-135 scope check)', async () => {
    // Provision a sibling project so we have a real cross-project task to
    // address. This guards the route against the historical bug where the
    // route would happily mark a task in project B as done because the URL
    // path's projectId was project A.
    const { projectId: otherProjectId } = await createTestProject('r114-other-owner');
    try {
      const { version: otherVersion } = await createActivePlan(otherProjectId, 'r114-other-owner');
      const otherTask = await testPrisma.task.create({
        data: {
          projectId: otherProjectId,
          title: 'cross-project victim',
          type: 'code',
          priority: 'p1',
          status: 'in_progress',
          assignee: owner,
          assigneeType: 'human',
          boundPlanVersion: otherVersion,
          agentConstraints: [],
        },
      });

      const res = await completeHumanPost(
        makeReq(`/api/projects/${projectId}/tasks/${otherTask.id}/complete-human`, {
          method: 'POST',
          userName: owner,
          body: { completionNote: 'attempt cross-project complete' },
        }),
        { params: { projectId, taskId: otherTask.id } },
      );

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');

      const refreshed = await testPrisma.task.findUnique({ where: { id: otherTask.id } });
      expect(refreshed?.status).toBe('in_progress');
    } finally {
      await cleanupProject(otherProjectId);
    }
  });

  it('rejects empty completionNote and oversized completionNote with 400 VALIDATION_ERROR', async () => {
    const task = await makeHumanTask({ title: 'schema validation' });

    const empty = await completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/complete-human`, {
        method: 'POST',
        userName: assignee,
        body: { completionNote: '' },
      }),
      { params: { projectId, taskId: task.id } },
    );
    expect(empty.status).toBe(400);

    const tooLong = await completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/complete-human`, {
        method: 'POST',
        userName: assignee,
        body: { completionNote: 'x'.repeat(5001) },
      }),
      { params: { projectId, taskId: task.id } },
    );
    expect(tooLong.status).toBe(400);

    const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(refreshed?.status).toBe('in_progress');
  });

  it('rejects malformed prUrl with 400', async () => {
    const task = await makeHumanTask({ title: 'bad pr url' });
    const res = await completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/complete-human`, {
        method: 'POST',
        userName: assignee,
        body: { completionNote: 'has bad url', prUrl: 'not-a-url' },
      }),
      { params: { projectId, taskId: task.id } },
    );

    expect(res.status).toBe(400);
    const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(refreshed?.status).toBe('in_progress');
  });
});

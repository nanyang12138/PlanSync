// F module: Task management
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as tasksPost, GET as tasksGet } from '@/app/api/projects/[projectId]/tasks/route';
import {
  PATCH as taskPatch,
  DELETE as taskDelete,
} from '@/app/api/projects/[projectId]/tasks/[taskId]/route';
import { POST as claimPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/claim/route';
import { POST as declinePost } from '@/app/api/projects/[projectId]/tasks/[taskId]/decline/route';
import { POST as runsPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/route';
import { POST as runActionPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/[runId]/route';
import { POST as rebindPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/rebind/route';
import { GET as packGet } from '@/app/api/projects/[projectId]/tasks/[taskId]/pack/route';
import {
  makeReq,
  createTestProject,
  addMember,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('F: Task Management', () => {
  const owner = 'task-owner';
  const dev = 'task-dev';
  let projectId: string;
  let activePlanVersion: number;
  let taskId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, dev);
    const { version } = await createActivePlan(projectId, owner);
    activePlanVersion = version;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('F1: POST /tasks (active plan exists) → 201, boundPlanVersion correct', async () => {
    const res = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Task Alpha', type: 'code', priority: 'p1' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.boundPlanVersion).toBe(activePlanVersion);
    taskId = body.data.id;
  });

  it('F2: POST /tasks (no active plan) → 400', async () => {
    // Create a fresh project without an active plan
    const { projectId: freshProjId } = await createTestProject('no-plan-owner');
    const res = await tasksPost(
      makeReq(`/api/projects/${freshProjId}/tasks`, {
        method: 'POST',
        userName: 'no-plan-owner',
        body: { title: 'Should Fail', type: 'code' },
      }),
      { params: { projectId: freshProjId } },
    );
    expect(res.status).toBe(409);
    await cleanupProject(freshProjId);
  });

  it('F3: type enum valid → 201, invalid → 400', async () => {
    for (const type of ['code', 'research', 'design', 'bug', 'refactor']) {
      const res = await tasksPost(
        makeReq(`/api/projects/${projectId}/tasks`, {
          method: 'POST',
          userName: owner,
          body: { title: `Type ${type}`, type },
        }),
        { params: { projectId } },
      );
      expect(res.status).toBe(201);
    }
    const badRes = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Bad type', type: 'invalid_type' },
      }),
      { params: { projectId } },
    );
    expect(badRes.status).toBe(400);
  });

  it('F4: priority enum p0/p1/p2 valid, invalid → 400', async () => {
    for (const priority of ['p0', 'p1', 'p2']) {
      const res = await tasksPost(
        makeReq(`/api/projects/${projectId}/tasks`, {
          method: 'POST',
          userName: owner,
          body: { title: `Priority ${priority}`, type: 'code', priority },
        }),
        { params: { projectId } },
      );
      expect(res.status).toBe(201);
    }
    const badRes = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Bad priority', type: 'code', priority: 'p3' },
      }),
      { params: { projectId } },
    );
    expect(badRes.status).toBe(400);
  });

  it('F5: GET /tasks → 200, list', async () => {
    const res = await tasksGet(makeReq(`/api/projects/${projectId}/tasks`, { userName: owner }), {
      params: { projectId },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('F14: POST task with agentContext/expectedOutput → 201, fields saved', async () => {
    const res = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'Agentic Task',
          type: 'code',
          agentContext: 'use typescript',
          expectedOutput: 'working code',
          agentConstraints: ['no external deps'],
        },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.agentContext).toBe('use typescript');
    expect(body.data.expectedOutput).toBe('working code');
  });

  it('F15: GET /tasks?status=todo → only todo tasks', async () => {
    const res = await tasksGet(
      makeReq(`/api/projects/${projectId}/tasks`, {
        userName: owner,
        searchParams: { status: 'todo' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    for (const t of body.data) {
      expect(t.status).toBe('todo');
    }
  });

  it('F16: POST task with non-member assignee → 400', async () => {
    const res = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'Assigned Task',
          type: 'code',
          assignee: 'not-a-member',
          assigneeType: 'human',
        },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(400);
  });

  it('F17: POST task with valid member assignee → 201, assignee set', async () => {
    const res = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Assigned Task Valid', type: 'code', assignee: dev, assigneeType: 'human' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.assignee).toBe(dev);
  });

  it('F12: PATCH /tasks/:id {title, priority} → 200, fields updated', async () => {
    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}`, {
        method: 'PATCH',
        userName: owner,
        body: { title: 'Updated Title', priority: 'p0' },
      }),
      { params: { projectId, taskId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe('Updated Title');
    expect(body.data.priority).toBe('p0');
  });

  it('F13: assigneeType invalid → 400', async () => {
    const res = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Bad assigneeType', type: 'code', assigneeType: 'robot' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(400);
  });

  it('F9: GET /tasks/:id/pack → 200, contains plan', async () => {
    const res = await packGet(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/pack`, { userName: owner }),
      { params: { projectId, taskId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.task).toBeDefined();
    expect(body.data.plan).not.toBeNull();
  });

  it('F6: POST /claim → 200, assignee=current user, status=in_progress', async () => {
    // Create a fresh todo task
    const createRes = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Claimable Task', type: 'code' },
      }),
      { params: { projectId } },
    );
    const claimableId = (await createRes.json()).data.id;

    const res = await claimPost(
      makeReq(`/api/projects/${projectId}/tasks/${claimableId}/claim`, {
        method: 'POST',
        userName: dev,
        body: { assigneeType: 'human', startImmediately: true },
      }),
      { params: { projectId, taskId: claimableId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.assignee).toBe(dev);
    expect(body.data.status).toBe('in_progress');
  });

  it('F7: claim already claimed task → 409', async () => {
    // Create and claim a task
    const createRes = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Already Claimed', type: 'code' },
      }),
      { params: { projectId } },
    );
    const alreadyClaimedId = (await createRes.json()).data.id;
    await claimPost(
      makeReq(`/api/projects/${projectId}/tasks/${alreadyClaimedId}/claim`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, taskId: alreadyClaimedId } },
    );

    // Try to claim again
    const res = await claimPost(
      makeReq(`/api/projects/${projectId}/tasks/${alreadyClaimedId}/claim`, {
        method: 'POST',
        userName: dev,
        body: {},
      }),
      { params: { projectId, taskId: alreadyClaimedId } },
    );
    expect(res.status).toBe(409);
  });

  it('F20: claim startImmediately=false → status=todo, assignee set', async () => {
    const createRes = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Slow Claim', type: 'code' },
      }),
      { params: { projectId } },
    );
    const slowId = (await createRes.json()).data.id;

    const res = await claimPost(
      makeReq(`/api/projects/${projectId}/tasks/${slowId}/claim`, {
        method: 'POST',
        userName: dev,
        body: { startImmediately: false, assigneeType: 'human' },
      }),
      { params: { projectId, taskId: slowId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.assignee).toBe(dev);
    expect(body.data.status).toBe('todo');
  });

  it('F21: POST /decline (assignee) → 200, unassigned', async () => {
    const createRes = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Task to Decline', type: 'code' },
      }),
      { params: { projectId } },
    );
    const declineTaskId = (await createRes.json()).data.id;

    // Claim with startImmediately=false so status stays todo
    await claimPost(
      makeReq(`/api/projects/${projectId}/tasks/${declineTaskId}/claim`, {
        method: 'POST',
        userName: dev,
        body: { startImmediately: false, assigneeType: 'human' },
      }),
      { params: { projectId, taskId: declineTaskId } },
    );

    const res = await declinePost(
      makeReq(`/api/projects/${projectId}/tasks/${declineTaskId}/decline`, {
        method: 'POST',
        userName: dev,
        body: {},
      }),
      { params: { projectId, taskId: declineTaskId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.assignee).toBeNull();
  });

  it('F22: POST /decline (non-assignee) → 403', async () => {
    const createRes = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Not Mine', type: 'code' },
      }),
      { params: { projectId } },
    );
    const ownedId = (await createRes.json()).data.id;

    // Claim as owner
    await claimPost(
      makeReq(`/api/projects/${projectId}/tasks/${ownedId}/claim`, {
        method: 'POST',
        userName: owner,
        body: { startImmediately: false },
      }),
      { params: { projectId, taskId: ownedId } },
    );

    // Dev tries to decline
    const res = await declinePost(
      makeReq(`/api/projects/${projectId}/tasks/${ownedId}/decline`, {
        method: 'POST',
        userName: dev,
        body: {},
      }),
      { params: { projectId, taskId: ownedId } },
    );
    expect(res.status).toBe(403);
  });

  it('F23: decline in_progress task → 409 STATE_CONFLICT', async () => {
    const createRes = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'In Progress Task', type: 'code' },
      }),
      { params: { projectId } },
    );
    const inProgId = (await createRes.json()).data.id;

    // Claim (in_progress)
    await claimPost(
      makeReq(`/api/projects/${projectId}/tasks/${inProgId}/claim`, {
        method: 'POST',
        userName: dev,
        body: { assigneeType: 'human', startImmediately: true },
      }),
      { params: { projectId, taskId: inProgId } },
    );

    // Try to decline while in_progress
    const res = await declinePost(
      makeReq(`/api/projects/${projectId}/tasks/${inProgId}/decline`, {
        method: 'POST',
        userName: dev,
        body: {},
      }),
      { params: { projectId, taskId: inProgId } },
    );
    expect(res.status).toBe(409);
  });

  it('F8: POST /rebind → boundPlanVersion updated', async () => {
    // Create a second active plan (supersedes current)
    const plan2 = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'Plan V2',
        goal: 'g',
        scope: 's',
        version: activePlanVersion + 1,
        status: 'active',
        createdBy: owner,
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
      },
    });
    // Mark old plan superseded
    await testPrisma.plan.updateMany({
      where: { projectId, status: 'active', id: { not: plan2.id } },
      data: { status: 'superseded' },
    });

    const res = await rebindPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/rebind`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, taskId } },
    );
    expect(res.status).toBe(200);
    const task = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(task?.boundPlanVersion).toBe(activePlanVersion + 1);
  });

  it('F10: todo→in_progress→done state transitions (via execution_complete)', async () => {
    const createRes = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'State Machine Task', type: 'code' },
      }),
      { params: { projectId } },
    );
    const smId = (await createRes.json()).data.id;

    // Move to in_progress via execution start (creates run + sets status)
    const runRes = await runsPost(
      makeReq(`/api/projects/${projectId}/tasks/${smId}/runs`, {
        method: 'POST',
        userName: owner,
        body: { executorType: 'human', executorName: owner },
      }),
      { params: { projectId, taskId: smId } },
    );
    expect(runRes.status).toBe(201);
    const runId = (await runRes.json()).data.id;

    const taskAfterRun = await testPrisma.task.findUnique({ where: { id: smId } });
    expect(taskAfterRun?.status).toBe('in_progress');

    // Complete via execution_complete → task auto-set to done
    const completeRes = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${smId}/runs/${runId}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: {
          status: 'completed',
          outputSummary: 'done',
          deliverablesMet: ['completed the required task work'],
        },
      }),
      { params: { projectId, taskId: smId, runId } },
    );
    expect(completeRes.status).toBe(200);

    const taskAfterComplete = await testPrisma.task.findUnique({ where: { id: smId } });
    expect(taskAfterComplete?.status).toBe('done');
  });

  it('F11: todo→done (skip) → 409 STATE_CONFLICT', async () => {
    const createRes = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Skip State Task', type: 'code' },
      }),
      { params: { projectId } },
    );
    const skipId = (await createRes.json()).data.id;

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${skipId}`, {
        method: 'PATCH',
        userName: owner,
        body: { status: 'done' },
      }),
      { params: { projectId, taskId: skipId } },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('STATE_CONFLICT');
  });

  it('F24: PATCH {assignee:dev} → assignee updated', async () => {
    const createRes = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Reassign Task', type: 'code' },
      }),
      { params: { projectId } },
    );
    const reassignId = (await createRes.json()).data.id;

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${reassignId}`, {
        method: 'PATCH',
        userName: owner,
        body: { assignee: dev, assigneeType: 'human' },
      }),
      { params: { projectId, taskId: reassignId } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.assignee).toBe(dev);
  });

  it('F25: PATCH {assignee:null} → unassigned', async () => {
    const createRes = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Unassign Task', type: 'code', assignee: dev, assigneeType: 'human' },
      }),
      { params: { projectId } },
    );
    const unassignId = (await createRes.json()).data.id;

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${unassignId}`, {
        method: 'PATCH',
        userName: owner,
        body: { assignee: null, assigneeType: 'unassigned' },
      }),
      { params: { projectId, taskId: unassignId } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.assignee).toBeNull();
  });

  it('F29: DELETE /tasks/:id (owner) → 200', async () => {
    const createRes = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'To Delete', type: 'code' },
      }),
      { params: { projectId } },
    );
    const deleteId = (await createRes.json()).data.id;

    const res = await taskDelete(
      makeReq(`/api/projects/${projectId}/tasks/${deleteId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: { projectId, taskId: deleteId } },
    );
    expect(res.status).toBe(200);
  });

  it('F30: DELETE /tasks/:id (developer) → 403', async () => {
    const createRes = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Not Delete', type: 'code' },
      }),
      { params: { projectId } },
    );
    const nodeId = (await createRes.json()).data.id;

    const res = await taskDelete(
      makeReq(`/api/projects/${projectId}/tasks/${nodeId}`, {
        method: 'DELETE',
        userName: dev,
      }),
      { params: { projectId, taskId: nodeId } },
    );
    expect(res.status).toBe(403);
  });
});

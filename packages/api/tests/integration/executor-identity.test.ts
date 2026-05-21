// R-009: heartbeat/complete endpoint enforces executor identity.
//
// Previously, any project member could PATCH any execution run because the
// route only called requireProjectRole(). This test exercises the new gate:
// only the executor themselves, the project owner, or an exec-scoped API key
// bound to that run may update it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as runActionPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/[runId]/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  addMember,
  testPrisma,
} from '../helpers/request';

describe('R-009: executor identity gate on /runs/[runId]', () => {
  const owner = 'r009-owner';
  const executor = 'r009-executor';
  const intruder = 'r009-intruder';
  let projectId: string;
  let taskId: string;
  let runId: string;
  let planVersion: number;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const { version } = await createActivePlan(projectId, owner);
    planVersion = version;

    await addMember(projectId, executor, 'developer');
    await addMember(projectId, intruder, 'developer');

    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'R-009 task',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: executor,
        assigneeType: 'human',
        boundPlanVersion: planVersion,
        agentConstraints: [],
      },
    });
    taskId = task.id;

    const run = await testPrisma.executionRun.create({
      data: {
        taskId,
        executorType: 'human',
        executorName: executor,
        boundPlanVersion: planVersion,
        status: 'running',
        taskPackSnapshot: {},
        lastHeartbeatAt: new Date(),
        filesChanged: [],
        blockers: [],
        driftSignals: [],
      },
    });
    runId = run.id;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('rejects heartbeat from a different developer with 403', async () => {
    const res = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=heartbeat`, {
        method: 'POST',
        userName: intruder,
        body: {},
      }),
      { params: { projectId, taskId, runId } },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toMatch(/executor or project owner/i);
  });

  it('rejects complete from a different developer with 403', async () => {
    const res = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`, {
        method: 'POST',
        userName: intruder,
        body: {
          status: 'completed',
          outputSummary: 'pretend',
          deliverablesMet: ['hijacked the run'],
        },
      }),
      { params: { projectId, taskId, runId } },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('allows heartbeat from the actual executor', async () => {
    const res = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=heartbeat`, {
        method: 'POST',
        userName: executor,
        body: {},
      }),
      { params: { projectId, taskId, runId } },
    );
    expect(res.status).toBe(200);
  });

  it('allows heartbeat from the project owner', async () => {
    const res = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=heartbeat`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, taskId, runId } },
    );
    expect(res.status).toBe(200);
  });
});

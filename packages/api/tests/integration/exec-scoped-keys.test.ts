// Exec-scoped API key: blocks task / plan creation from /worker + /exec sessions
// even when they bypass MCP via raw bash + curl.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as issuePost } from '@/app/api/exec-sessions/issue-token/route';
import { POST as revokePost } from '@/app/api/exec-sessions/revoke-token/route';
import { POST as tasksPost } from '@/app/api/projects/[projectId]/tasks/route';
import { POST as plansPost } from '@/app/api/projects/[projectId]/plans/route';
import { POST as proposePost } from '@/app/api/projects/[projectId]/plans/[planId]/propose/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('Exec-scoped API key', () => {
  const owner = 'exec-key-owner';
  let projectId: string;
  let taskId: string;
  let runId: string;
  let scopedKey: string;
  let activePlanVersion: number;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const { version } = await createActivePlan(projectId, owner);
    activePlanVersion = version;

    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'Scoped key test task',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: owner,
        assigneeType: 'human',
        boundPlanVersion: version,
        agentConstraints: [],
      },
    });
    taskId = task.id;

    const run = await testPrisma.executionRun.create({
      data: {
        taskId,
        executorType: 'human',
        executorName: owner,
        boundPlanVersion: version,
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

  it('issues a scoped key tied to runId', async () => {
    const res = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        body: { runId, taskId, projectId },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.key).toMatch(/^ps_key_exec_/);
    expect(body.data.execRunId).toBe(runId);
    scopedKey = body.data.key;

    const stored = await testPrisma.apiKey.findFirst({ where: { execRunId: runId } });
    expect(stored?.expiresAt).toBeTruthy();
  });

  it('blocks POST /tasks when called with scoped key', async () => {
    const res = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: {
          title: 'Should be blocked',
          type: 'code',
          priority: 'p1',
          boundPlanVersion: activePlanVersion,
        },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toMatch(/Exec-scoped/i);
  });

  it('blocks POST /plans when called with scoped key', async () => {
    const res = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: {
          title: 'Sneaky plan',
          goal: 'g',
          scope: 's',
          constraints: [],
          standards: [],
          deliverables: [],
        },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(403);
  });

  it('blocks POST /plans/:id/propose when called with scoped key', async () => {
    const draft = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'Draft for propose-block test',
        goal: 'g',
        scope: 's',
        version: activePlanVersion + 100,
        status: 'draft',
        createdBy: owner,
      },
    });
    const res = await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${draft.id}/propose`, {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: { reviewers: [owner] },
      }),
      { params: { projectId, planId: draft.id } },
    );
    expect(res.status).toBe(403);
  });

  it('blocks POST /plans/:id/activate when called with scoped key', async () => {
    const proposed = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'Proposed for activate-block test',
        goal: 'g',
        scope: 's',
        version: activePlanVersion + 200,
        status: 'proposed',
        createdBy: owner,
      },
    });
    const res = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${proposed.id}/activate`, {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: {},
      }),
      { params: { projectId, planId: proposed.id } },
    );
    expect(res.status).toBe(403);
  });

  it('owner key (non-scoped) can still create tasks (regression)', async () => {
    const res = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'Allowed by owner key',
          type: 'code',
          priority: 'p1',
          boundPlanVersion: activePlanVersion,
        },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(201);
  });

  it('refuses to issue a scoped key from within a scoped session', async () => {
    const res = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: { runId, taskId, projectId },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('expired scoped key is rejected as invalid', async () => {
    await testPrisma.apiKey.updateMany({
      where: { execRunId: runId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: {
          title: 'After expiry',
          type: 'code',
          priority: 'p1',
          boundPlanVersion: activePlanVersion,
        },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(401);
  });

  it('revoke endpoint deletes the scoped key row', async () => {
    // Issue a fresh one (the previous one was expired in the test above)
    await testPrisma.apiKey.deleteMany({ where: { execRunId: runId } });
    await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        body: { runId, taskId, projectId },
      }),
    );
    const before = await testPrisma.apiKey.count({ where: { execRunId: runId } });
    expect(before).toBe(1);

    const res = await revokePost(
      makeReq('/api/exec-sessions/revoke-token', {
        method: 'POST',
        userName: owner,
        body: { runId },
      }),
    );
    expect(res.status).toBe(200);
    const after = await testPrisma.apiKey.count({ where: { execRunId: runId } });
    expect(after).toBe(0);
  });
});

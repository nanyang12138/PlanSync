// Exec-scoped API key: blocks task / plan creation from /worker + /exec sessions
// even when they bypass MCP via raw bash + curl.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as issuePost } from '@/app/api/exec-sessions/issue-token/route';
import { POST as revokePost } from '@/app/api/exec-sessions/revoke-token/route';
import { GET as tasksGet, POST as tasksPost } from '@/app/api/projects/[projectId]/tasks/route';
import { POST as plansPost } from '@/app/api/projects/[projectId]/plans/route';
import { POST as proposePost } from '@/app/api/projects/[projectId]/plans/[planId]/propose/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { POST as reactivatePost } from '@/app/api/projects/[projectId]/plans/[planId]/reactivate/route';
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

  it('blocks POST /plans/:id/reactivate when called with scoped key', async () => {
    const superseded = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'Superseded for reactivate-block test',
        goal: 'g',
        scope: 's',
        version: activePlanVersion + 300,
        status: 'superseded',
        createdBy: owner,
      },
    });
    const res = await reactivatePost(
      makeReq(`/api/projects/${projectId}/plans/${superseded.id}/reactivate`, {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: {},
      }),
      { params: { projectId, planId: superseded.id } },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toMatch(/Exec-scoped/i);
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

  // R-011: an exec-scoped key issued for project A must not grant access
  // to project B even when the same user is a member of both projects.
  it('R-011: exec-scoped key from project A is rejected by project B routes', async () => {
    // Issue a fresh exec-scoped key bound to project A's run
    await testPrisma.apiKey.deleteMany({ where: { execRunId: runId } });
    const issueRes = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        body: { runId, taskId, projectId },
      }),
    );
    expect(issueRes.status).toBe(201);
    const projectAKey = (await issueRes.json()).data.key as string;

    // Create a second project (project B) where the same user is owner.
    // The key being scoped to project A must not let the caller read
    // project B's tasks even though they are a member there.
    const { projectId: projectBId } = await createTestProject(owner);
    try {
      const denied = await tasksGet(
        makeReq(`/api/projects/${projectBId}/tasks`, {
          userName: owner,
          authToken: projectAKey,
        }),
        { params: { projectId: projectBId } },
      );
      expect(denied.status).toBe(403);
      const body = await denied.json();
      expect(body.error.message).toMatch(/exec-scoped/i);

      // Sanity: same key still works on its own project (read-only).
      const allowed = await tasksGet(
        makeReq(`/api/projects/${projectId}/tasks`, {
          userName: owner,
          authToken: projectAKey,
        }),
        { params: { projectId } },
      );
      expect(allowed.status).toBe(200);
    } finally {
      await cleanupProject(projectBId);
    }
  });

  // R-080: ApiKey.execRunId now has an FK to execution_runs with
  // ON DELETE SET NULL, so removing the run preserves the key row but
  // clears the back-reference. This protects audit history (we keep the
  // ApiKey for traceability) while preventing dangling pointers.
  it('R-080: deleting the execution run nulls execRunId on associated keys', async () => {
    await testPrisma.apiKey.deleteMany({ where: { execRunId: runId } });
    const issueRes = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        body: { runId, taskId, projectId },
      }),
    );
    expect(issueRes.status).toBe(201);
    const key = await testPrisma.apiKey.findFirst({ where: { execRunId: runId } });
    expect(key).not.toBeNull();
    const keyId = key!.id;

    const isolatedRun = await testPrisma.executionRun.create({
      data: {
        taskId,
        executorType: 'human',
        executorName: owner,
        boundPlanVersion: activePlanVersion,
        status: 'completed',
        taskPackSnapshot: {},
        filesChanged: [],
        blockers: [],
        driftSignals: [],
        endedAt: new Date(),
      },
    });
    await testPrisma.apiKey.update({
      where: { id: keyId },
      data: { execRunId: isolatedRun.id },
    });

    await testPrisma.executionRun.delete({ where: { id: isolatedRun.id } });

    const refreshed = await testPrisma.apiKey.findUnique({ where: { id: keyId } });
    expect(refreshed).not.toBeNull();
    expect(refreshed!.execRunId).toBeNull();

    await testPrisma.apiKey.delete({ where: { id: keyId } });
  });

  // R-080: with the FK in place, inserting an api_keys row referencing
  // a missing execution run must fail. Previously this silently produced
  // a dangling reference.
  it('R-080: inserting api_key with unknown execRunId is rejected by the FK', async () => {
    await expect(
      testPrisma.apiKey.create({
        data: {
          projectId,
          name: 'orphan',
          keyHash: 'hash',
          keyPrefix: 'ps_key_orphan_',
          permissions: [],
          createdBy: owner,
          execRunId: 'cl_does_not_exist_zzz',
        },
      }),
    ).rejects.toThrow();
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

// R-015 [HIGH] · B2
// Verify that an exec-scoped API key (issued for a single execution run)
// cannot perform owner-only mutations on the following routes:
//
//   PATCH/DELETE /projects/:projectId
//   PATCH/DELETE /projects/:projectId/plans/:planId
//   POST         /projects/:projectId/plans/:planId/append
//   DELETE       /projects/:projectId/tasks/:taskId
//   POST         /projects/:projectId/members
//   PATCH/DELETE /projects/:projectId/members/:memberId
//   POST         /projects/:projectId/webhooks
//   POST         /projects/:projectId/notify
//
// All of these previously only checked role; an exec-scoped key from a
// /worker or /exec session could therefore mutate plans, tasks, members,
// webhooks, and trigger notify emails. After R-015 every route runs
// requireNotExecScoped(auth) up front and returns 403 for scoped keys.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as issuePost } from '@/app/api/exec-sessions/issue-token/route';
import {
  PATCH as projectPatch,
  DELETE as projectDelete,
} from '@/app/api/projects/[projectId]/route';
import {
  PATCH as planPatch,
  DELETE as planDelete,
} from '@/app/api/projects/[projectId]/plans/[planId]/route';
import { POST as planAppendPost } from '@/app/api/projects/[projectId]/plans/[planId]/append/route';
import { DELETE as taskDelete } from '@/app/api/projects/[projectId]/tasks/[taskId]/route';
import { POST as memberCreatePost } from '@/app/api/projects/[projectId]/members/route';
import {
  PATCH as memberPatch,
  DELETE as memberDelete,
} from '@/app/api/projects/[projectId]/members/[memberId]/route';
import { POST as webhookPost } from '@/app/api/projects/[projectId]/webhooks/route';
import { POST as notifyPost } from '@/app/api/projects/[projectId]/notify/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('R-015: exec-scoped key blocked on owner-only write routes', () => {
  const owner = 'r015-owner';
  let projectId: string;
  let planId: string;
  let draftPlanId: string;
  let taskId: string;
  let runId: string;
  let scopedKey: string;
  let extraMemberId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const { planId: activePlanId, version } = await createActivePlan(projectId, owner);
    planId = activePlanId;

    const draft = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'R-015 draft plan',
        goal: 'g',
        scope: 's',
        version: version + 1,
        status: 'draft',
        createdBy: owner,
        constraints: ['initial'],
      },
    });
    draftPlanId = draft.id;

    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'R-015 task',
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

    // Add a second member so we have something to PATCH / DELETE.
    const extra = await testPrisma.projectMember.create({
      data: { projectId, name: 'r015-dev', role: 'developer', type: 'human' },
    });
    extraMemberId = extra.id;

    // Mint a scoped key for the run created above.
    const issueRes = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        body: { runId, taskId, projectId },
      }),
    );
    expect(issueRes.status).toBe(201);
    scopedKey = (await issueRes.json()).data.key as string;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  // Reusable assertion: response is 403 and message mentions exec-scope.
  async function expectExecScopedDenial(res: Response) {
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toMatch(/Exec-scoped/i);
  }

  it('PATCH /projects/:projectId → 403', async () => {
    const res = await projectPatch(
      makeReq(`/api/projects/${projectId}`, {
        method: 'PATCH',
        userName: owner,
        authToken: scopedKey,
        body: { name: 'renamed-by-scoped-key' },
      }),
      { params: { projectId } },
    );
    await expectExecScopedDenial(res);
  });

  it('DELETE /projects/:projectId → 403', async () => {
    const res = await projectDelete(
      makeReq(`/api/projects/${projectId}`, {
        method: 'DELETE',
        userName: owner,
        authToken: scopedKey,
      }),
      { params: { projectId } },
    );
    await expectExecScopedDenial(res);
  });

  it('PATCH /projects/:projectId/plans/:planId → 403', async () => {
    const res = await planPatch(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}`, {
        method: 'PATCH',
        userName: owner,
        authToken: scopedKey,
        body: { title: 'renamed-draft' },
      }),
      { params: { projectId, planId: draftPlanId } },
    );
    await expectExecScopedDenial(res);
  });

  it('DELETE /projects/:projectId/plans/:planId → 403', async () => {
    const res = await planDelete(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}`, {
        method: 'DELETE',
        userName: owner,
        authToken: scopedKey,
      }),
      { params: { projectId, planId: draftPlanId } },
    );
    await expectExecScopedDenial(res);
  });

  it('POST /projects/:projectId/plans/:planId/append → 403', async () => {
    const res = await planAppendPost(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}/append`, {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: { field: 'constraints', items: ['sneaky-constraint'] },
      }),
      { params: { projectId, planId: draftPlanId } },
    );
    await expectExecScopedDenial(res);
  });

  it('DELETE /projects/:projectId/tasks/:taskId → 403', async () => {
    const res = await taskDelete(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}`, {
        method: 'DELETE',
        userName: owner,
        authToken: scopedKey,
      }),
      { params: { projectId, taskId } },
    );
    await expectExecScopedDenial(res);
  });

  it('POST /projects/:projectId/members → 403', async () => {
    const res = await memberCreatePost(
      makeReq(`/api/projects/${projectId}/members`, {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: { name: 'sneaky-new-member', role: 'developer', type: 'human' },
      }),
      { params: { projectId } },
    );
    await expectExecScopedDenial(res);
  });

  it('PATCH /projects/:projectId/members/:memberId → 403', async () => {
    const res = await memberPatch(
      makeReq(`/api/projects/${projectId}/members/${extraMemberId}`, {
        method: 'PATCH',
        userName: owner,
        authToken: scopedKey,
        body: { role: 'owner' },
      }),
      { params: { projectId, memberId: extraMemberId } },
    );
    await expectExecScopedDenial(res);
  });

  it('DELETE /projects/:projectId/members/:memberId → 403', async () => {
    const res = await memberDelete(
      makeReq(`/api/projects/${projectId}/members/${extraMemberId}`, {
        method: 'DELETE',
        userName: owner,
        authToken: scopedKey,
      }),
      { params: { projectId, memberId: extraMemberId } },
    );
    await expectExecScopedDenial(res);
  });

  it('POST /projects/:projectId/webhooks → 403', async () => {
    const res = await webhookPost(
      makeReq(`/api/projects/${projectId}/webhooks`, {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: { url: 'https://example.com/hook', events: ['task_done'] },
      }),
      { params: { projectId } },
    );
    await expectExecScopedDenial(res);
  });

  it('POST /projects/:projectId/notify → 403', async () => {
    const res = await notifyPost(
      makeReq(`/api/projects/${projectId}/notify`, {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: { type: 'plan_owner', planId },
      }),
      { params: { projectId } },
    );
    await expectExecScopedDenial(res);
  });

  // Regression sanity check: the same owner using a non-scoped session can
  // still call one of the guarded routes. This ensures the guard is not
  // over-blocking legitimate owner access.
  it('regression: owner key (non-scoped) can still PATCH the project', async () => {
    const res = await projectPatch(
      makeReq(`/api/projects/${projectId}`, {
        method: 'PATCH',
        userName: owner,
        body: { name: `t-rename-${Date.now()}` },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
  });
});

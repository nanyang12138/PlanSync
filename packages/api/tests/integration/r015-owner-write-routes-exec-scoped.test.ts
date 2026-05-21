// R-015 [HIGH/B2]: All owner-only write routes must reject exec-scoped API keys.
//
// Exec-scoped keys are minted for a single execution run and are NOT
// allowed to mutate project-level resources (plans, projects, tasks,
// members, webhooks, notifications) — even when the underlying user
// is the project owner. This guards against /exec or /worker sub-agents
// bypassing MCP via raw bash + curl.
//
// This test exercises each protected route with an exec-scoped key and
// expects a 403 with the "Exec-scoped" error message produced by
// `requireNotExecScoped`.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as issuePost } from '@/app/api/exec-sessions/issue-token/route';
import {
  PATCH as planPatch,
  DELETE as planDelete,
} from '@/app/api/projects/[projectId]/plans/[planId]/route';
import { POST as planAppendPost } from '@/app/api/projects/[projectId]/plans/[planId]/append/route';
import {
  PATCH as projectPatch,
  DELETE as projectDelete,
} from '@/app/api/projects/[projectId]/route';
import { DELETE as taskDelete } from '@/app/api/projects/[projectId]/tasks/[taskId]/route';
import { POST as membersPost } from '@/app/api/projects/[projectId]/members/route';
import {
  PATCH as memberPatch,
  DELETE as memberDelete,
} from '@/app/api/projects/[projectId]/members/[memberId]/route';
import { POST as webhooksPost } from '@/app/api/projects/[projectId]/webhooks/route';
import { POST as notifyPost } from '@/app/api/projects/[projectId]/notify/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('R-015 — owner-only write routes reject exec-scoped keys', () => {
  const owner = 'r015-owner';
  let projectId: string;
  let planVersion: number;
  let draftPlanId: string;
  let activePlanId: string;
  let memberId: string;
  let taskId: string;
  let runId: string;
  let scopedKey: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const { planId, version } = await createActivePlan(projectId, owner);
    activePlanId = planId;
    planVersion = version;

    const draft = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'R-015 draft',
        goal: 'g',
        scope: 's',
        version: planVersion + 1,
        status: 'draft',
        createdBy: owner,
      },
    });
    draftPlanId = draft.id;

    const extraMember = await testPrisma.projectMember.create({
      data: { projectId, name: 'r015-dev', role: 'developer', type: 'human' },
    });
    memberId = extraMember.id;

    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'R-015 task to delete',
        type: 'code',
        priority: 'p1',
        status: 'todo',
        assigneeType: 'agent',
        boundPlanVersion: planVersion,
        agentConstraints: [],
      },
    });
    taskId = task.id;

    const run = await testPrisma.executionRun.create({
      data: {
        taskId,
        executorType: 'human',
        executorName: owner,
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

    const issueRes = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        body: { runId, taskId, projectId },
      }),
    );
    expect(issueRes.status).toBe(201);
    scopedKey = (await issueRes.json()).data.key;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  function expectExecScopedRejection(status: number, message: string) {
    expect(status).toBe(403);
    expect(message).toMatch(/Exec-scoped/i);
  }

  it('PATCH /plans/:id is rejected with scoped key', async () => {
    const res = await planPatch(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}`, {
        method: 'PATCH',
        userName: owner,
        authToken: scopedKey,
        body: { title: 'tampered' },
      }),
      { params: { projectId, planId: draftPlanId } },
    );
    const body = await res.json();
    expectExecScopedRejection(res.status, body.error?.message ?? '');
  });

  it('DELETE /plans/:id is rejected with scoped key', async () => {
    const res = await planDelete(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}`, {
        method: 'DELETE',
        userName: owner,
        authToken: scopedKey,
      }),
      { params: { projectId, planId: draftPlanId } },
    );
    const body = await res.json();
    expectExecScopedRejection(res.status, body.error?.message ?? '');
  });

  it('POST /plans/:id/append is rejected with scoped key', async () => {
    const res = await planAppendPost(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}/append`, {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: { field: 'constraints', items: ['injected'] },
      }),
      { params: { projectId, planId: draftPlanId } },
    );
    const body = await res.json();
    expectExecScopedRejection(res.status, body.error?.message ?? '');
  });

  it('PATCH /projects/:id is rejected with scoped key', async () => {
    const res = await projectPatch(
      makeReq(`/api/projects/${projectId}`, {
        method: 'PATCH',
        userName: owner,
        authToken: scopedKey,
        body: { name: 'evil-rename' },
      }),
      { params: { projectId } },
    );
    const body = await res.json();
    expectExecScopedRejection(res.status, body.error?.message ?? '');
  });

  it('DELETE /projects/:id is rejected with scoped key', async () => {
    const res = await projectDelete(
      makeReq(`/api/projects/${projectId}`, {
        method: 'DELETE',
        userName: owner,
        authToken: scopedKey,
      }),
      { params: { projectId } },
    );
    const body = await res.json();
    expectExecScopedRejection(res.status, body.error?.message ?? '');
  });

  it('DELETE /tasks/:id is rejected with scoped key', async () => {
    const res = await taskDelete(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}`, {
        method: 'DELETE',
        userName: owner,
        authToken: scopedKey,
      }),
      { params: { projectId, taskId } },
    );
    const body = await res.json();
    expectExecScopedRejection(res.status, body.error?.message ?? '');
  });

  it('POST /members is rejected with scoped key', async () => {
    const res = await membersPost(
      makeReq(`/api/projects/${projectId}/members`, {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: { name: 'r015-injected', role: 'developer', type: 'human' },
      }),
      { params: { projectId } },
    );
    const body = await res.json();
    expectExecScopedRejection(res.status, body.error?.message ?? '');
  });

  it('PATCH /members/:id is rejected with scoped key', async () => {
    const res = await memberPatch(
      makeReq(`/api/projects/${projectId}/members/${memberId}`, {
        method: 'PATCH',
        userName: owner,
        authToken: scopedKey,
        body: { role: 'owner' },
      }),
      { params: { projectId, memberId } },
    );
    const body = await res.json();
    expectExecScopedRejection(res.status, body.error?.message ?? '');
  });

  it('DELETE /members/:id is rejected with scoped key', async () => {
    const res = await memberDelete(
      makeReq(`/api/projects/${projectId}/members/${memberId}`, {
        method: 'DELETE',
        userName: owner,
        authToken: scopedKey,
      }),
      { params: { projectId, memberId } },
    );
    const body = await res.json();
    expectExecScopedRejection(res.status, body.error?.message ?? '');
  });

  it('POST /webhooks is rejected with scoped key', async () => {
    const res = await webhooksPost(
      makeReq(`/api/projects/${projectId}/webhooks`, {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: { url: 'https://example.com/h', events: ['plan_activated'] },
      }),
      { params: { projectId } },
    );
    const body = await res.json();
    expectExecScopedRejection(res.status, body.error?.message ?? '');
  });

  it('POST /notify is rejected with scoped key', async () => {
    const res = await notifyPost(
      makeReq(`/api/projects/${projectId}/notify`, {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: { type: 'plan_owner', planId: activePlanId },
      }),
      { params: { projectId } },
    );
    const body = await res.json();
    expectExecScopedRejection(res.status, body.error?.message ?? '');
  });

  // Regression: owner with a non-scoped key (password Bearer / makeReq default)
  // still passes through these routes — the new guard only rejects exec-scoped
  // callers. We exercise one cheap mutation to confirm we did not break owners.
  it('regression: owner without exec-scoped key can still PATCH /plans/:id (draft)', async () => {
    const res = await planPatch(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}`, {
        method: 'PATCH',
        userName: owner,
        body: { title: 'owner-can-still-edit' },
      }),
      { params: { projectId, planId: draftPlanId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe('owner-can-still-edit');
  });
});

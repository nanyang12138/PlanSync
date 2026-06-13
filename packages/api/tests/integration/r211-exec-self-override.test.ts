/**
 * R-211 — separation of duties on the `→ done` PATCH.
 *
 * The done-branch of `PATCH /tasks/:id` lets the *project owner* override
 * every R-192 evidence protection (owner administrative close). That trust
 * is meant for a human owner acting through a normal session. But
 * `requireProjectRole` derives `projectRole` verbatim from
 * `ProjectMember.role`, and an exec-scoped API key (minted per run via
 * /exec-sessions/issue-token, carrying `execRunId`) does NOT cap that role.
 * So a member registered as `role: owner` that is also the run executor
 * could, through its own run's key, claim owner authority and rubber-stamp
 * `done` — defeating the gate its run just failed.
 *
 * The fix strips the owner privilege from exec-scoped callers in the
 * done-branch (`isOwner = role==='owner' && !auth.execRunId`), so an
 * owner-role exec key falls under the same evidence-based non-owner
 * protections as any other executor. These tests pin both halves:
 *   - owner-role caller through its OWN exec key is blocked by the
 *     existing "agent task needs a completed run" rule,
 *   - the same owner through a normal (non-exec) session still overrides,
 *     proving the administrative path is untouched.
 *
 * We use an agent task whose latest run is still `running` (no completed
 * run on file): the run executor has produced no evidence yet, so closing
 * it `done` would be a pure self-attestation. Pre-fix the exec owner sailed
 * through; post-fix it hits the non-owner guard.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { POST as issuePost } from '@/app/api/exec-sessions/issue-token/route';
import { PATCH as taskPatch } from '@/app/api/projects/[projectId]/tasks/[taskId]/route';
import { invalidateApiKeyCacheByExecRunId } from '@/lib/auth';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

// The owner is deliberately ALSO the run executor — this is the
// dangerous self-attestation shape the guard defends against.
const owner = 'r211-owner';

let projectId: string;
let planVersion: number;

beforeAll(async () => {
  ({ projectId } = await createTestProject(owner));
  const { version } = await createActivePlan(projectId, owner);
  planVersion = version;
});

afterAll(async () => {
  await cleanupProject(projectId);
});

beforeEach(async () => {
  await testPrisma.executionRun.deleteMany({ where: { task: { projectId } } });
  await testPrisma.task.deleteMany({ where: { projectId } });
});

/**
 * An agent task in `in_progress` whose latest run is still `running`
 * (no completed run yet). For a non-owner caller the done-branch's
 * "agent task cannot be marked done without a completed execution run"
 * rule fires; for an owner caller it is bypassed. The exec key minted
 * for the running run is the channel under test.
 */
async function makeRunningAgentTask() {
  const task = await testPrisma.task.create({
    data: {
      projectId,
      title: 'running agent task',
      type: 'code',
      priority: 'p1',
      status: 'in_progress',
      assignee: owner,
      assigneeType: 'agent',
      boundPlanVersion: planVersion,
      agentConstraints: [],
    },
  });
  const run = await testPrisma.executionRun.create({
    data: {
      taskId: task.id,
      executorType: 'agent',
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
  return { taskId: task.id, runId: run.id };
}

async function mintExecKey(runId: string, taskId: string): Promise<string> {
  const res = await issuePost(
    makeReq('/api/exec-sessions/issue-token', {
      method: 'POST',
      userName: owner,
      body: { runId, taskId, projectId },
    }),
  );
  expect(res.status).toBe(201);
  const body = await res.json();
  return body.data.key as string;
}

describe('R-211: exec-scoped owner cannot self-attest done', () => {
  it('blocks an owner-role caller acting through its own exec key', async () => {
    const { taskId, runId } = await makeRunningAgentTask();
    const scopedKey = await mintExecKey(runId, taskId);

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}`, {
        method: 'PATCH',
        userName: owner,
        authToken: scopedKey,
        body: { status: 'done' },
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );

    // Owner privilege stripped → falls to the agent-needs-a-completed-run
    // rule (STATE_CONFLICT), exactly as any non-owner executor would.
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toMatch(/completed execution run/i);

    const refreshed = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(refreshed?.status).toBe('in_progress');

    invalidateApiKeyCacheByExecRunId(runId);
  });

  it('still allows the same owner to override from a normal (non-exec) session', async () => {
    const { taskId } = await makeRunningAgentTask();

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}`, {
        method: 'PATCH',
        userName: owner,
        body: { status: 'done' },
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );

    expect(res.status).toBe(200);
    const refreshed = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(refreshed?.status).toBe('done');
  });
});

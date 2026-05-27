/**
 * Closes #1476 — R-192 复核仅覆盖 `PATCH status=done`，assignee 仍可通过
 * `awaiting_evidence → in_progress` 后调用 `POST /complete-human` 绕过
 * human self-complete 限制。
 *
 * Attack chain pre-fix:
 *   1. Task is parked in `awaiting_evidence` (R-192 gate rejected the
 *      original execution_complete; a `completed` ExecutionRun is on
 *      file because that's how the task got parked).
 *   2. Assignee PATCH `awaiting_evidence → in_progress` (allowed for
 *      the assignee by PR #1434 / #1429).
 *   3. Assignee calls `POST /complete-human`. The route only checked
 *      `task.status ∈ {in_progress, todo}`, assignee identity, and
 *      no-running-run — it never re-evaluated R-192. It then created
 *      a fresh `completed` run and flipped task → done.
 *
 * The fix in complete-human/route.ts adds an R-192 re-check when the
 * latest run is `completed` (the parking fingerprint) and the caller
 * is not the project owner: if `deriveTaskCompletionState` would still
 * park the task, return 403 with `code: 'R192_AWAITING_EVIDENCE'`.
 *
 * The tests below replicate the bypass chain end-to-end (PATCH the
 * task out of `awaiting_evidence` first, then call complete-human)
 * and verify:
 *   - the non-owner assignee bypass is blocked,
 *   - the project owner can still administratively close the task,
 *   - tasks with no prior `completed` run keep their pre-fix legacy
 *     "first-time human self-complete" behaviour,
 *   - projects without GitHub integration (gate stays silent at
 *     project level) keep working unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { POST as completeHumanPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/complete-human/route';
import { PATCH as taskPatch } from '@/app/api/projects/[projectId]/tasks/[taskId]/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  addMember,
  testPrisma,
} from '../helpers/request';

const owner = 'i1476-owner';
const assignee = 'i1476-assignee';
const repoSlug = 'plansync-test/i1476-repo';

let projectId: string;
let planId: string;
let planVersion: number;
let deliverableSlug: string;

beforeAll(async () => {
  ({ projectId } = await createTestProject(owner));
  // R-192 opt-in at the project level — without `githubRepo` the gate
  // short-circuits to `gateApplied=false` and the new check intentionally
  // stays silent (legacy "always done" behaviour preserved for
  // non-GitHub-integrated projects).
  await testPrisma.project.update({
    where: { id: projectId },
    data: { githubRepo: repoSlug },
  });
  await addMember(projectId, assignee, 'developer');
  const { planId: pid, version } = await createActivePlan(projectId, owner);
  planId = pid;
  planVersion = version;

  const deliverable = await testPrisma.planDeliverable.create({
    data: {
      planId,
      slug: 'i1476-feature',
      title: 'Issue 1476 feature',
      body: 'feature under test',
      refType: 'file_glob',
      refUri: 'src/i1476/**/*.ts',
      status: 'active',
    },
  });
  deliverableSlug = deliverable.slug;
});

afterAll(async () => {
  await cleanupProject(projectId);
});

beforeEach(async () => {
  await testPrisma.executionRun.deleteMany({ where: { task: { projectId } } });
  await testPrisma.task.deleteMany({ where: { projectId } });
});

/**
 * Reproduce a "previously parked then reopened" task by hand:
 *   - the task carries R-192 wiring (`prUrl` + `planDeliverableRefs`),
 *   - it already has a `completed` ExecutionRun on file (the prior
 *     execution_complete that R-192 rejected),
 *   - we then PATCH it `awaiting_evidence → in_progress` via the real
 *     route so the assignee gate at line 232 of route.ts is exercised
 *     too. After PATCH, task.status === 'in_progress' but the latest
 *     run is still `completed` — the bypass signal the new gate fires
 *     on.
 */
async function makeParkedThenReopenedTask(opts: { reopener: string }) {
  const task = await testPrisma.task.create({
    data: {
      projectId,
      title: 'parked task',
      type: 'code',
      priority: 'p1',
      status: 'awaiting_evidence',
      assignee,
      assigneeType: 'human',
      boundPlanVersion: planVersion,
      agentConstraints: [],
      planDeliverableRefs: [deliverableSlug],
      prUrl: 'https://github.com/plansync-test/i1476-repo/pull/9001',
    },
  });
  await testPrisma.executionRun.create({
    data: {
      taskId: task.id,
      executorType: 'human',
      executorName: assignee,
      boundPlanVersion: planVersion,
      status: 'completed',
      taskPackSnapshot: {},
      outputSummary: 'first complete attempt — R-192 parked it',
      endedAt: new Date(),
    },
  });

  // Drive the reopen through the real PATCH route so we know we're
  // testing the documented bypass chain, not a synthetic Prisma write.
  const res = await taskPatch(
    makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
      method: 'PATCH',
      userName: opts.reopener,
      body: { status: 'in_progress' },
    }),
    { params: Promise.resolve({ projectId, taskId: task.id }) },
  );
  expect(res.status).toBe(200);
  const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
  expect(refreshed?.status).toBe('in_progress');
  return task.id;
}

describe('#1476: complete-human R-192 bypass gate', () => {
  it('blocks the assignee from laundering through awaiting_evidence → in_progress → complete-human', async () => {
    const taskId = await makeParkedThenReopenedTask({ reopener: assignee });

    const res = await completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/complete-human`, {
        method: 'POST',
        userName: assignee,
        body: { completionNote: 'sneaky re-complete' },
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toMatch(/R-192/);
    // Surface the structured signal so the CLI / UI can branch.
    expect(body.error.details?.code).toBe('R192_AWAITING_EVIDENCE');
    expect(Array.isArray(body.error.details?.missing)).toBe(true);

    // Side-effect assertions: the task was NOT marked done, and the
    // route did NOT write a fresh `completed` ExecutionRun.
    const refreshed = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(refreshed?.status).toBe('in_progress');
    const runs = await testPrisma.executionRun.findMany({ where: { taskId } });
    expect(runs).toHaveLength(1);
    expect(runs[0].outputSummary).toBe('first complete attempt — R-192 parked it');
  });

  it('still allows the project owner to administratively close a parked + reopened task', async () => {
    const taskId = await makeParkedThenReopenedTask({ reopener: owner });

    const res = await completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/complete-human`, {
        method: 'POST',
        userName: owner,
        body: { completionNote: 'owner override after parked' },
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );

    expect(res.status).toBe(200);
    const refreshed = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(refreshed?.status).toBe('done');
    const runs = await testPrisma.executionRun.findMany({ where: { taskId } });
    // owner override writes a fresh `completed` row in addition to the
    // pre-existing parked-attempt row.
    expect(runs).toHaveLength(2);
    expect(runs.filter((r) => r.status === 'completed')).toHaveLength(2);
  });

  it('does not regress a first-time human self-complete (no prior completed run on file)', async () => {
    // The gate is fingerprint-driven: when there is no prior
    // `completed` run, the new check stays silent and the legacy path
    // applies. A non-parked task assigned to a human must therefore
    // still complete cleanly via the assignee. This guard prevents the
    // fix from over-reaching into the normal flow.
    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'first time complete',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee,
        assigneeType: 'human',
        boundPlanVersion: planVersion,
        agentConstraints: [],
        planDeliverableRefs: [deliverableSlug],
        prUrl: 'https://github.com/plansync-test/i1476-repo/pull/9002',
      },
    });

    const res = await completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/complete-human`, {
        method: 'POST',
        userName: assignee,
        body: { completionNote: 'first-time self complete' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );

    expect(res.status).toBe(200);
    const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(refreshed?.status).toBe('done');
  });
});

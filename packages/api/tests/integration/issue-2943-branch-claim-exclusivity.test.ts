/**
 * #2943: branch-claim exclusivity at execution-start.
 *
 * Background
 * ----------
 * #2941 made the `require_pr_merged` verification gate bind PR ownership to
 * the branch a run records at START (`run.branchName`): the merged PR's head
 * branch must EQUAL the run's recorded branch, so a mutable `task.prUrl`
 * cannot be repointed at an unrelated PR right before complete.
 *
 * The residual hole #2943 reports: `run.branchName` is supplied by the
 * executor in the start request, so it is forgeable. Two runs execute
 * concurrently; the lazy/malicious executor for run B records run A's
 * working branch at start, does no work, then repoints `task.prUrl` at run
 * A's merged PR before complete. The head-branch equality holds (B copied
 * A's branch) and A's honest in-window push satisfies the binding — B
 * clears the gate on borrowed work.
 *
 * The fix: a branch can be the working branch of at most ONE live
 * (`running`) run per project. The start route holds the project advisory
 * lock and rejects a start whose `branchName` equals (with the same
 * `refs/heads/`-tolerant semantics the gate uses) a branch already claimed
 * by another running run — so B can never record A's branch while A runs.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { POST as runsPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

const owner = 'issue-2943-owner';

async function makeTask(projectId: string, version: number, title: string) {
  const task = await testPrisma.task.create({
    data: {
      projectId,
      title,
      type: 'code',
      priority: 'p1',
      status: 'todo',
      assignee: owner,
      assigneeType: 'human',
      boundPlanVersion: version,
      planDeliverableRefs: [],
      agentConstraints: [],
    },
  });
  return task.id;
}

async function startRun(projectId: string, taskId: string, branchName?: string) {
  return runsPost(
    makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs`, {
      method: 'POST',
      userName: owner,
      body: { executorType: 'human', executorName: owner, branchName },
    }),
    { params: Promise.resolve({ projectId, taskId }) },
  );
}

describe('#2943: branch-claim exclusivity across concurrent runs', () => {
  let projectId: string;

  afterEach(async () => {
    if (projectId) await cleanupProject(projectId);
  });

  it('rejects a second run that claims a branch already held by a running run', async () => {
    const setup = await createTestProject(owner);
    projectId = setup.projectId;
    const { version } = await createActivePlan(projectId, owner);
    const taskA = await makeTask(projectId, version, 'task A');
    const taskB = await makeTask(projectId, version, 'task B');

    // Run A (honest) claims the branch and stays running.
    const resA = await startRun(projectId, taskA, 'cursor/fix-foo');
    expect(resA.status).toBe(201);

    // Run B tries to record the SAME branch while A is still running → reject.
    const resB = await startRun(projectId, taskB, 'cursor/fix-foo');
    expect(resB.status).toBe(409);
    const bodyB = await resB.json();
    expect(bodyB.error.code).toBe('STATE_CONFLICT');
    expect(bodyB.error.message).toMatch(/already claimed by an active execution/);
    expect(bodyB.error.details?.branchName).toBe('cursor/fix-foo');

    // Crucially: no running run was created for task B.
    const runsB = await testPrisma.executionRun.findMany({ where: { taskId: taskB } });
    expect(runsB).toHaveLength(0);
  });

  it('normalizes refs/heads/ so a prefixed branch cannot evade the claim', async () => {
    const setup = await createTestProject(owner);
    projectId = setup.projectId;
    const { version } = await createActivePlan(projectId, owner);
    const taskA = await makeTask(projectId, version, 'task A');
    const taskB = await makeTask(projectId, version, 'task B');

    // A records the short name; B tries the refs/heads/-prefixed form of the
    // same branch — equal under the gate's comparison, so it must be rejected.
    expect((await startRun(projectId, taskA, 'cursor/shared')).status).toBe(201);
    const resB = await startRun(projectId, taskB, 'refs/heads/cursor/shared');
    expect(resB.status).toBe(409);
    expect((await resB.json()).error.code).toBe('STATE_CONFLICT');
  });

  it('allows a different branch to start concurrently', async () => {
    const setup = await createTestProject(owner);
    projectId = setup.projectId;
    const { version } = await createActivePlan(projectId, owner);
    const taskA = await makeTask(projectId, version, 'task A');
    const taskB = await makeTask(projectId, version, 'task B');

    expect((await startRun(projectId, taskA, 'cursor/branch-a')).status).toBe(201);
    // A distinct branch is free to be claimed by a parallel run.
    expect((await startRun(projectId, taskB, 'cursor/branch-b')).status).toBe(201);
  });

  it('frees the claim once the holding run is no longer running', async () => {
    const setup = await createTestProject(owner);
    projectId = setup.projectId;
    const { version } = await createActivePlan(projectId, owner);
    const taskA = await makeTask(projectId, version, 'task A');
    const taskB = await makeTask(projectId, version, 'task B');

    const resA = await startRun(projectId, taskA, 'cursor/recyclable');
    expect(resA.status).toBe(201);
    const runA = (await resA.json()).data;

    // Once A's run finishes the branch is no longer exclusively held.
    await testPrisma.executionRun.update({
      where: { id: runA.id },
      data: { status: 'completed', endedAt: new Date() },
    });

    expect((await startRun(projectId, taskB, 'cursor/recyclable')).status).toBe(201);
  });

  it('does not constrain runs that record no branch (back-compat #2939)', async () => {
    const setup = await createTestProject(owner);
    projectId = setup.projectId;
    const { version } = await createActivePlan(projectId, owner);
    const taskA = await makeTask(projectId, version, 'task A');
    const taskB = await makeTask(projectId, version, 'task B');

    // Neither run records a branch → no claim contention; both start.
    expect((await startRun(projectId, taskA)).status).toBe(201);
    expect((await startRun(projectId, taskB)).status).toBe(201);
  });
});

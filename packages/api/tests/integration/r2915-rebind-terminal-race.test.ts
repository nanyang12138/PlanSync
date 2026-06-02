// #2915 (must): /tasks/:id/rebind must not clobber a terminal task status that
// a concurrent writer committed between the in-transaction `liveTask` read and
// the status-reset write.
//
// The rebind transaction takes the per-project advisory lock, which serializes
// it against `plan_activate` and `drift_resolve`. It does NOT, however,
// serialize against the PATCH (`/tasks/:id`) and `execution_complete`
// (`/runs/:id`) paths — neither takes that lock. So those routes can flip a
// task to `done`/`cancelled` in the window between rebind's `tx.task.findUnique`
// read and its `status → todo` write. Pre-fix, rebind computed `isTerminal`
// from the stale read and then unconditionally wrote `status='todo'`,
// resurrecting a finished task and overwriting its terminal status — a
// data-loss / correctness defect.
//
// The fix expresses the reset as a conditional UPDATE
// (`status NOT IN ('done','cancelled')`). Under READ COMMITTED Postgres
// re-evaluates that predicate against the latest committed row (EvalPlanQual)
// after blocking on the concurrent writer's row lock, so a terminal transition
// in the gap makes the reset match 0 rows and the terminal status survives.
//
// We exercise the race deterministically: a SECOND connection opens a
// transaction that `UPDATE`s the task to `done` and HOLDS the row lock open.
// rebind then reads the (still-committed) non-terminal status, enters the reset
// branch, and BLOCKS on the held row lock. When the holder commits and releases
// the lock, the conditional UPDATE re-checks the predicate, sees `done`, and
// preserves it.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { POST as taskRebindPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/rebind/route';
import { makeReq, createTestProject, cleanupProject, testPrisma } from '../helpers/request';

const owner = 'r2915-owner';

// A dedicated connection so we can hold a transaction (and its row lock) open
// while the route runs on the production Prisma singleton's own connection.
const holdPrisma = new PrismaClient();

async function setupProjectWithV2() {
  const { projectId } = await createTestProject(owner);
  await testPrisma.plan.create({
    data: {
      projectId,
      title: 'V1',
      goal: 'v1 goal',
      scope: 'v1 scope',
      version: 1,
      status: 'superseded',
      createdBy: owner,
      constraints: [],
      standards: [],
      deliverables: [],
      openQuestions: [],
      requiredReviewers: [],
    },
  });
  await testPrisma.plan.create({
    data: {
      projectId,
      title: 'V2',
      goal: 'v2 goal',
      scope: 'v2 scope',
      version: 2,
      status: 'active',
      createdBy: owner,
      activatedAt: new Date(),
      activatedBy: owner,
      constraints: [],
      standards: [],
      deliverables: [],
      openQuestions: [],
      requiredReviewers: [],
    },
  });
  return projectId;
}

async function createTaskBoundToV1(projectId: string, status: string) {
  const task = await testPrisma.task.create({
    data: {
      projectId,
      title: `#2915 task (${status})`,
      type: 'code',
      priority: 'p1',
      status,
      assignee: owner,
      assigneeType: 'human',
      boundPlanVersion: 1,
      agentConstraints: [],
    },
  });
  return task.id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('#2915: rebind preserves a concurrently-committed terminal status', () => {
  let projectId: string;

  beforeEach(async () => {
    projectId = await setupProjectWithV2();
  });

  afterEach(async () => {
    if (projectId) await cleanupProject(projectId);
  });

  afterAll(async () => {
    await holdPrisma.$disconnect();
  });

  it('does NOT reset to todo when a concurrent writer flips the task to done mid-transaction', async () => {
    const taskId = await createTaskBoundToV1(projectId, 'in_progress');

    // Holder tx: flip to `done` and keep the row lock until we release it.
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const holdTx = holdPrisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE tasks SET status = 'done' WHERE id = ${taskId}`;
        await barrier;
      },
      { timeout: 20_000 },
    );

    // Let the holder acquire the row lock before rebind starts.
    await sleep(250);

    // rebind reads the still-committed `in_progress`, enters the reset branch,
    // then blocks on the held row lock.
    const rebindPromise = taskRebindPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/rebind`, {
        method: 'POST',
        userName: owner,
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );

    // Give rebind time to reach and block on the conditional UPDATE.
    await sleep(500);

    // Holder commits `done` and frees the lock; rebind's UPDATE re-checks the
    // predicate against the now-`done` row.
    release();
    await holdTx;

    const res = await rebindPromise;
    expect(res.status).toBe(200);

    const after = await testPrisma.task.findUnique({ where: { id: taskId } });
    // Terminal status preserved; only the version reference moved.
    expect(after?.status).toBe('done');
    expect(after?.boundPlanVersion).toBe(2);
  });

  it('still resets a non-terminal task to todo when there is no contention', async () => {
    const taskId = await createTaskBoundToV1(projectId, 'in_progress');

    const res = await taskRebindPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/rebind`, {
        method: 'POST',
        userName: owner,
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );
    expect(res.status).toBe(200);

    const after = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(after?.status).toBe('todo');
    expect(after?.boundPlanVersion).toBe(2);
  });
});

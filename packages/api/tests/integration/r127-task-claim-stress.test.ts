// R-127: Concurrent claim stress test.
//
// R-049 made the task-claim path atomic by using a conditional
// `prisma.task.updateMany({ where: { ..., assignee: null, status: 'todo' } })`
// and treating `count === 0` as STATE_CONFLICT. F7b in tasks.test.ts proved
// the invariant for two concurrent claimers; this file stresses the same
// guarantee under higher concurrency (N >> 2) and across multiple rounds, so
// a transient race-window regression cannot pass by sheer luck of scheduling
// in the Promise microtask queue.
//
// Invariant under test (per task, per round):
//   * Exactly one claim returns 200.
//   * Every other claim returns 409 with one of the two legitimate
//     "you lost" shapes:
//       (a) CONFLICT + details.code === 'TASK_ALREADY_CLAIMED' — the loser
//           reached the conditional updateMany while the winner's row was
//           still `assignee=null` to the loser's MVCC snapshot, and the
//           updateMany short-read returned count===0 (ErrorCode.CONFLICT).
//       (b) STATE_CONFLICT 'Only todo tasks can be claimed' — the loser's
//           pre-claim findFirst already saw status='in_progress' (winner had
//           committed startImmediately=true), so the route bailed out before
//           even attempting the updateMany.
//     Both shapes are correct outcomes of the R-049 atomic gate. The
//     forbidden outcome is `okCount > 1`, which would be the canonical
//     regression shape if someone re-introduced a findFirst → update
//     read/modify pair without the `where: { assignee: null, status: 'todo' }`
//     guard on the write itself.
//   * The DB row reflects the winning claimer (assignee + in_progress status).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as tasksPost } from '@/app/api/projects/[projectId]/tasks/route';
import { POST as claimPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/claim/route';
import {
  makeReq,
  createTestProject,
  addMember,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

const CLAIMERS_PER_TASK = 20;
const ROUNDS = 5;

describe('R-127: concurrent task claim stress', () => {
  const owner = 'r127-owner';
  let projectId: string;
  const claimers: string[] = Array.from({ length: CLAIMERS_PER_TASK }, (_, i) => `r127-c${i}`);

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    for (const c of claimers) {
      await addMember(projectId, c);
    }
    await createActivePlan(projectId, owner);
  }, 30_000);

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  async function createTodoTask(title: string): Promise<string> {
    const created = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title, type: 'code' },
      }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(created.status).toBe(201);
    return (await created.json()).data.id;
  }

  it(`${CLAIMERS_PER_TASK} concurrent claimers → exactly one wins, rest get TASK_ALREADY_CLAIMED`, async () => {
    const taskId = await createTodoTask('R-127 single-task stress');

    const responses = await Promise.all(
      claimers.map((userName) =>
        claimPost(
          makeReq(`/api/projects/${projectId}/tasks/${taskId}/claim`, {
            method: 'POST',
            userName,
            body: { assigneeType: 'human', startImmediately: true },
          }),
          { params: Promise.resolve({ projectId, taskId }) },
        ),
      ),
    );

    const okResponses = responses.filter((r) => r.status === 200);
    const conflictResponses = responses.filter((r) => r.status === 409);

    // Hard gate: exactly one winner.
    expect(okResponses).toHaveLength(1);
    expect(conflictResponses).toHaveLength(claimers.length - 1);
    // No surprise statuses (e.g. 500) — concurrency must not crash the route.
    expect(okResponses.length + conflictResponses.length).toBe(claimers.length);

    const winnerBody = await okResponses[0].json();
    expect(claimers).toContain(winnerBody.data.assignee);
    expect(winnerBody.data.status).toBe('in_progress');

    // Every loser must carry one of the two legitimate "lost the race"
    // shapes — see comment block at the top of this file. We accept both so
    // the test does not become flaky on scheduling order, but we explicitly
    // forbid any *other* error shape (no generic 500s, no Prisma error
    // bleed-through, no schema-validation 400s).
    let claimedAlreadyCount = 0;
    let stateConflictCount = 0;
    for (const res of conflictResponses) {
      const body = await res.json();
      const code = body.error?.code;
      const detailsCode = body.error?.details?.code;
      if (code === 'CONFLICT' && detailsCode === 'TASK_ALREADY_CLAIMED') {
        claimedAlreadyCount++;
      } else if (code === 'STATE_CONFLICT') {
        stateConflictCount++;
      } else {
        throw new Error(
          `Unexpected loser response: code=${String(code)} detailsCode=${String(detailsCode)} body=${JSON.stringify(body)}`,
        );
      }
    }
    // Sanity: every conflict response was classified into exactly one bucket.
    expect(claimedAlreadyCount + stateConflictCount).toBe(conflictResponses.length);

    const finalTask = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(finalTask?.assignee).toBe(winnerBody.data.assignee);
    expect(finalTask?.status).toBe('in_progress');
  }, 30_000);

  it(`${ROUNDS} rounds of stress → invariant holds every round`, async () => {
    // Run the same race against a fresh task each round. A scheduling-luck
    // bug that lets two claims through one in ~10 runs would still light up
    // here within ROUNDS rounds.
    for (let round = 0; round < ROUNDS; round++) {
      const taskId = await createTodoTask(`R-127 round ${round}`);

      const responses = await Promise.all(
        claimers.map((userName) =>
          claimPost(
            makeReq(`/api/projects/${projectId}/tasks/${taskId}/claim`, {
              method: 'POST',
              userName,
              body: { assigneeType: 'human', startImmediately: true },
            }),
            { params: Promise.resolve({ projectId, taskId }) },
          ),
        ),
      );

      const okCount = responses.filter((r) => r.status === 200).length;
      const conflictCount = responses.filter((r) => r.status === 409).length;
      expect(okCount, `round ${round} winners`).toBe(1);
      expect(conflictCount, `round ${round} losers`).toBe(claimers.length - 1);

      const finalTask = await testPrisma.task.findUnique({ where: { id: taskId } });
      expect(finalTask?.status).toBe('in_progress');
      expect(finalTask?.assignee).not.toBeNull();
      expect(claimers).toContain(finalTask?.assignee);
    }
  }, 60_000);
});

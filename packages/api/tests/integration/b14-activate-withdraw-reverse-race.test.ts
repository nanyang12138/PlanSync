/**
 * Closes #903 #984 — the activate ⇄ withdraw race in BOTH directions.
 *
 * #816 (PR #867) closed the withdraw-loses-to-activate direction by
 * scoping withdraw's update to `status: 'proposed'` so a concurrent
 * activate that already flipped the plan can't be reverted.
 *
 * The OPPOSITE direction was still open: activate read the plan's
 * status OUTSIDE the transaction, then unconditionally
 * `tx.plan.update({ where: { id } })` — so a withdraw that ran
 * BETWEEN the read and the update would be silently overwritten,
 * resurrecting a freshly-withdrawn plan back to 'active'.
 *
 * The current fix mirrors the withdraw side: `updateMany` scoped to
 * `status: 'draft' | 'proposed'` with a count check that
 * STATE_CONFLICTs when a concurrent writer changed the row. NOTE:
 * this scope is itself the subject of #1167 — the proposed→draft
 * race specifically is NOT closed because 'draft' is still inside
 * the allowed-set, so the in-tx updateMany still matches a row
 * that withdraw just flipped to 'draft'. Tests in this file do
 * NOT pin "withdraw then activate succeeds" as expected behaviour
 * (#1168) — see the comments on each test for what is and isn't
 * covered here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as plansPost } from '@/app/api/projects/[projectId]/plans/route';
import { POST as proposePost } from '@/app/api/projects/[projectId]/plans/[planId]/propose/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { POST as withdrawPost } from '@/app/api/projects/[projectId]/plans/[planId]/withdraw/route';
import { makeReq, createTestProject, cleanupProject, testPrisma } from '../helpers/request';

describe('B14 / closes #903 #984 — activate cannot resurrect a withdrawn plan', () => {
  const owner = 'b14-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  /** Helper — propose a plan, returning its id. */
  async function makeProposedPlan(title: string): Promise<string> {
    const create = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title,
          goal: 'g',
          scope: 's',
          constraints: [],
          standards: [],
          deliverables: [],
          openQuestions: [],
          requiredReviewers: [],
        },
      }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(create.status).toBe(201);
    const planId = (await create.json()).data.id;

    const propose = await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/propose`, {
        method: 'POST',
        userName: owner,
        body: { reviewers: [] },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(propose.status).toBe(200);
    return planId;
  }

  it('sequential happy-path: drafts ARE activatable, so withdraw → activate?force=true returns 200 (NOT a race-fix assertion)', async () => {
    // IMPORTANT: this test is NOT validation that the in-tx race is
    // fixed. It's a sequential happy-path sanity check. The plan
    // state machine intentionally allows drafts to be activated
    // (route.ts L50 accepts both 'draft' and 'proposed'), so a
    // legitimate withdraw → re-propose → withdraw → activate flow
    // succeeds end-to-end — and SHOULD continue to succeed after
    // any tightening of the in-tx guard for #1167. The 200 here is
    // correct sequential behaviour; do NOT read it as "withdraw
    // followed by activate is the documented happy-path".
    //
    // Real coverage of the proposed→draft→active race must observe
    // the route's outer L50 read returning 'proposed' and the
    // in-tx update happening AFTER a concurrent withdraw committed
    // a 'draft' status. That deterministic interleave is sketched
    // in the it.todo below and tracked under #1167.
    const planId = await makeProposedPlan('B14-direct');

    const withdraw = await withdrawPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/withdraw`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(withdraw.status).toBe(200);

    const afterWithdraw = await testPrisma.plan.findUnique({ where: { id: planId } });
    expect(afterWithdraw?.status).toBe('draft');

    const propose2 = await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/propose`, {
        method: 'POST',
        userName: owner,
        body: { reviewers: [] },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(propose2.status).toBe(200);

    const withdraw2 = await withdrawPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/withdraw`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(withdraw2.status).toBe(200);

    const afterWithdraw2 = await testPrisma.plan.findUnique({
      where: { id: planId },
      select: { status: true },
    });
    expect(afterWithdraw2?.status).toBe('draft');

    const goodActivate = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/activate?force=true`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    // Sequential happy-path only — see the long comment above.
    expect(goodActivate.status).toBe(200);
    const afterActivate = await testPrisma.plan.findUnique({ where: { id: planId } });
    expect(afterActivate?.status).toBe('active');
  });

  it("OUTER guard only: row already in a non-activatable status (superseded) → activate route's L50 check rejects with 4xx", async () => {
    // What this test actually covers: the route's OUTER L50 check
    // (`if (plan.status !== 'draft' && plan.status !== 'proposed')`).
    // The row is flipped to 'superseded' BEFORE activate runs, so
    // by the time `requirePlanInProject` reads the row, the L50
    // branch fires and we never even enter the $transaction. That
    // means this test does NOT exercise the in-tx updateMany +
    // count check at all.
    //
    // Real in-tx coverage requires the L50 read to observe one
    // status and the in-tx update to land on a different status —
    // i.e. a concurrent writer between the read and the update.
    // That deterministic interleave is the it.todo below.
    const planId = await makeProposedPlan('B14-outer-guard-rejects-superseded');

    await testPrisma.plan.update({
      where: { id: planId },
      data: { status: 'superseded' },
    });

    const res = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/activate?force=true`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const after = await testPrisma.plan.findUnique({ where: { id: planId } });
    // Crucially: status was NOT silently flipped back to 'active'.
    // Pre-fix the in-tx update would have done exactly that, but
    // here it's the OUTER guard catching it — see comment above.
    expect(after?.status).toBe('superseded');
  });

  it('static guard: activate route uses an in-tx updateMany + count===0 STATE_CONFLICT branch', async () => {
    // Deliberately permissive on the WHERE shape: #1167 may
    // tighten `status: { in: ['draft','proposed'] }` to something
    // narrower (e.g. matching exactly the L50-observed status).
    // We pin the *intent* — there must be a status-scoped
    // updateMany inside the $transaction with a count===0 →
    // STATE_CONFLICT branch — without locking the specific
    // status set so that #1167's fix isn't blocked by this test.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../src/app/api/projects/[projectId]/plans/[planId]/activate/route.ts',
      ),
      'utf-8',
    );
    expect(src).toMatch(/tx\.plan\.updateMany\(/);
    // Some status-narrowing predicate must be present on the
    // in-tx updateMany — we don't pin its exact shape.
    expect(src).toMatch(/status:/);
    expect(src).toMatch(/\.count\s*===\s*0/);
    expect(src).toMatch(/STATE_CONFLICT/);
    expect(src).toMatch(/Closes #903 #984/);
  });

  // Tracked in #1167. Currently NOT implemented because adding a
  // deterministic in-tx race test now would either (a) assert the
  // buggy current behaviour and re-introduce the same lock-in
  // problem #1168 flagged, or (b) assert the post-fix behaviour
  // and conflict with the in-flight #1167 fix landing in a
  // separate PR. Once #1167 lands, the next maintainer should
  // unskip this and implement it as follows:
  //
  //   1. Create a 'proposed' plan p.
  //   2. Open an external testPrisma.$transaction T1 that does
  //      `SELECT id FROM plans WHERE id = p FOR UPDATE` to grab
  //      a row lock, then awaits an external "release" signal.
  //   3. Fire activatePost(p) — its outer L50 read sees
  //      'proposed', then its $transaction enters and the in-tx
  //      updateMany blocks on T1's row lock.
  //   4. While the activate is blocked, T1 updates the row to
  //      `status: 'draft'` (mimicking withdraw's effect) and
  //      commits, releasing the lock.
  //   5. Activate's updateMany unblocks; under READ COMMITTED it
  //      re-evaluates the WHERE against the post-T1 row.
  //   6. Assert: activateRes.status === 409 STATE_CONFLICT, plan
  //      stays 'draft'. Pre-#1167-fix this fails (route flips
  //      'draft' → 'active' silently); post-fix this holds.
  it.todo(
    "in-tx race coverage (#1167): withdraw committing between activate's L50 read and in-tx updateMany must STATE_CONFLICT, not silently re-activate",
  );
});

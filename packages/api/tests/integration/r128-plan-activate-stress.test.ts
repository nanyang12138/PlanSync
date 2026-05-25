// R-128: Concurrent plan-activate stress test.
//
// R-048 introduced two layered protections against the "multiple active plans
// per project" symptom:
//   1. A partial unique index `plans_one_active_per_project` that the database
//      itself enforces (any second `status='active'` row for the same project
//      raises P2002).
//   2. A `pg_advisory_xact_lock(hash(projectId))` inside the activate
//      transaction so concurrent requests serialise per project, plus a
//      preceding `updateMany(status='active' → 'superseded')` so each
//      transaction makes room for its own write before flipping its plan.
//
// `r048-one-active-plan-per-project.test.ts` already verifies the
// 2-concurrent-plans case. This file stresses the same combo at higher
// concurrency (N >> 2) and across multiple rounds — a regression that
// removed the advisory lock or the in-route updateMany would still happen
// to "win" against 2 attempts on a fast machine, but cannot survive
// repeated 10-way races without surfacing one of:
//   * `okCount === 0`                 — every request crashed (would mean
//                                       the route mishandles its own race).
//   * a 5xx / non-{200,409} status    — Prisma error bled through.
//   * `> 1` row with status='active'  — the DB-level invariant collapsed.
//   * an "active" row that wasn't one of this round's candidates — the
//     route flipped some unrelated plan.
//
// All of those are hard fails here; any combination of 200-and-409
// outcomes with exactly one active row at the end is correct, because
// "later activate supersedes earlier" is the documented behaviour.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { makeReq, createTestProject, cleanupProject, testPrisma } from '../helpers/request';

const PLANS_PER_ROUND = 10;
const ROUNDS = 5;

describe('R-128: concurrent plan activate stress', () => {
  const owner = 'r128-owner';
  let projectId: string;
  // Monotonic version counter so plans created across rounds never collide
  // on the @@unique([projectId, version]) constraint.
  let nextVersion = 1;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  }, 30_000);

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  // Insert N draft plans directly via Prisma. The public POST /plans route
  // refuses to create a second draft while one already exists for the
  // project, so there is no API path to set up an N-way race other than
  // bypassing the gate at the DB level. The database invariant we're
  // testing — partial unique on `status='active'` — is unaffected by
  // multiple drafts coexisting.
  async function seedDraftPlans(count: number, label: string): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const p = await testPrisma.plan.create({
        data: {
          projectId,
          title: `${label} #${i}`,
          goal: 'stress',
          scope: 'stress',
          version: nextVersion++,
          status: 'draft',
          createdBy: owner,
        },
      });
      ids.push(p.id);
    }
    return ids;
  }

  async function clearActive() {
    await testPrisma.plan.updateMany({
      where: { projectId, status: 'active' },
      data: { status: 'superseded' },
    });
  }

  it(`${PLANS_PER_ROUND} concurrent activates → exactly 1 active row, 0 unexpected statuses`, async () => {
    await clearActive();
    const planIds = await seedDraftPlans(PLANS_PER_ROUND, 'R-128 single round');

    // ?force=true bypasses the R-055 "proposed plan with 0 reviewers" gate
    // so this test exercises the R-048 concurrency path rather than being
    // short-circuited by the review-gate. The plans are draft anyway, but
    // future code that tightens activate to proposed-only would still keep
    // working with this flag.
    const responses = await Promise.all(
      planIds.map((planId) =>
        activatePost(
          makeReq(`/api/projects/${projectId}/plans/${planId}/activate?force=true`, {
            method: 'POST',
            userName: owner,
          }),
          { params: Promise.resolve({ projectId, planId }) },
        ),
      ),
    );

    let okCount = 0;
    let stateConflictCount = 0;
    for (const r of responses) {
      if (r.status === 200) {
        okCount++;
        continue;
      }
      // Anything that isn't 200 must be the documented 409 STATE_CONFLICT
      // shape ("Another plan was activated concurrently for this project").
      // A generic CONFLICT, a 500, a Prisma error envelope, or a
      // schema-validation 400 would all be regressions of R-048's contract.
      expect(r.status, `unexpected status ${r.status}`).toBe(409);
      const body = await r.json();
      expect(body.error?.code).toBe('STATE_CONFLICT');
      stateConflictCount++;
    }
    // We are deliberately permissive about the 200 vs 409 split — the
    // route's pre-tx `updateMany(active → superseded)` plus the advisory
    // lock means almost all attempts succeed serially in practice, but
    // the DB-level partial unique can still legitimately fire under
    // adversarial scheduling. What we cannot tolerate:
    //   * okCount === 0  → every request lost; service is down.
    //   * okCount + stateConflictCount !== N → there was an unhandled error.
    expect(okCount).toBeGreaterThanOrEqual(1);
    expect(okCount + stateConflictCount).toBe(planIds.length);

    // The user-visible invariant from R-048: at no point can two rows be
    // active for the same project. After all N requests have settled, the
    // DB must hold exactly one active row, and it must be one of the
    // candidates we seeded — not some unrelated plan that got mis-flipped.
    const activeRows = await testPrisma.plan.findMany({
      where: { projectId, status: 'active' },
    });
    expect(activeRows).toHaveLength(1);
    expect(planIds).toContain(activeRows[0].id);

    // Every loser candidate must be parked in 'superseded' (either by the
    // route's in-tx updateMany when it lost, or because it never won and
    // we reset it). The dangerous regression shape would be a plan that
    // stayed `draft` after activate returned 200 — that would mean the
    // tx returned success without actually flipping the row.
    const allCandidates = await testPrisma.plan.findMany({
      where: { id: { in: planIds } },
      select: { id: true, status: true },
    });
    const winnerId = activeRows[0].id;
    for (const p of allCandidates) {
      if (p.id === winnerId) {
        expect(p.status).toBe('active');
      } else {
        expect(p.status, `plan ${p.id} expected superseded`).toBe('superseded');
      }
    }
  }, 60_000);

  it(`${ROUNDS} rounds of ${PLANS_PER_ROUND}-way races → invariant holds every round`, async () => {
    // Re-running the same race against fresh sets of plans is a cheap way
    // to catch a scheduling-luck regression: a bug that lets two activates
    // concurrently land `status='active'` ~5% of the time would still
    // appear within ROUNDS rounds.
    for (let round = 0; round < ROUNDS; round++) {
      await clearActive();
      const planIds = await seedDraftPlans(PLANS_PER_ROUND, `R-128 round ${round}`);

      const responses = await Promise.all(
        planIds.map((planId) =>
          activatePost(
            makeReq(`/api/projects/${projectId}/plans/${planId}/activate?force=true`, {
              method: 'POST',
              userName: owner,
            }),
            { params: Promise.resolve({ projectId, planId }) },
          ),
        ),
      );

      const okCount = responses.filter((r) => r.status === 200).length;
      const conflictCount = responses.filter((r) => r.status === 409).length;
      expect(
        okCount + conflictCount,
        `round ${round}: ${responses.map((r) => r.status).join(',')}`,
      ).toBe(planIds.length);
      expect(okCount, `round ${round}: no winner`).toBeGreaterThanOrEqual(1);

      const activeRows = await testPrisma.plan.findMany({
        where: { projectId, status: 'active' },
      });
      expect(activeRows, `round ${round}: active row count`).toHaveLength(1);
      expect(planIds, `round ${round}: winner not in candidates`).toContain(activeRows[0].id);
    }
  }, 120_000);
});

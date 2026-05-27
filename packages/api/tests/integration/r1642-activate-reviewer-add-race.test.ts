/**
 * Closes #1642 — the activate ⇄ add-reviewer race.
 *
 * PR #1510 (closing #1167) tightened the activate route's in-tx guard
 * from `status: { in: ['draft', 'proposed'] }` to
 * `status: observedStatus`, closing the withdraw race where a concurrent
 * `proposed → draft` transition slipped through.
 *
 * Cursor review on #1510 pointed out (#1642) that the status-only guard
 * is necessary but NOT sufficient: both reviewer-add paths
 *
 *   • POST /api/projects/:p/plans/:plan/reviews
 *     (writes PlanReview + plan.update { requiredReviewers: { push } })
 *
 *   • PATCH /api/projects/:p/plans/:plan with `requiredReviewers`
 *     (writes scalar plan.update + planReview.createMany)
 *
 * create a new pending PlanReview WITHOUT changing plan.status. If one of
 * them lands between the activate route's outer review-gate (which reads
 * plan.reviews ONCE, outside the tx) and the in-tx flip, the status-only
 * guard still matches ('proposed' === 'proposed') and the route silently
 * activates a plan whose review set just gained a pending reviewer who
 * never approved — bypassing the very review gate the activate route just
 * passed.
 *
 * The fix re-validates the review set INSIDE the activate transaction
 * (under a `SELECT ... FOR UPDATE` on the plan row, so concurrent
 * reviewer-add transactions must serialize against our flip). This file
 * pins both directions of the race so the gate cannot regress:
 *
 *   • all-approved-then-pending-added (the canonical race)
 *   • zero-reviewers-?force-then-reviewer-added (the force-bypass race)
 *
 * Plus a happy-path control to confirm the in-tx re-validation doesn't
 * false-409 a legitimate activate, and a static-guard check that the new
 * `SELECT ... FOR UPDATE` + `tx.planReview.findMany` re-read both exist
 * in the route source.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as plansPost } from '@/app/api/projects/[projectId]/plans/route';
import { POST as proposePost } from '@/app/api/projects/[projectId]/plans/[planId]/propose/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import {
  makeReq,
  createTestProject,
  cleanupProject,
  resetDraftPlans,
  testPrisma,
  spyOnProductionPrisma,
} from '../helpers/request';

describe('R-1642 / closes #1642 — activate cannot bypass a concurrently-added reviewer', () => {
  const owner = 'r1642-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  /**
   * Helper: create a `proposed` plan with the given reviewers, then
   * approve each one so the outer review gate at L67–L87 of the
   * activate route passes on first read.
   */
  async function makeApprovedProposedPlan(
    title: string,
    reviewers: string[],
  ): Promise<{ planId: string }> {
    await resetDraftPlans(projectId);
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
        body: { reviewers },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(propose.status).toBe(200);

    await testPrisma.planReview.updateMany({
      where: { planId },
      data: { status: 'approved' },
    });

    return { planId };
  }

  it('legitimate activate with all reviewers approved still succeeds (no false 409 from in-tx re-read)', async () => {
    // Sanity check: the new in-tx FOR UPDATE + planReview re-read must
    // not break the happy path where no concurrent reviewer-add happens.
    const { planId } = await makeApprovedProposedPlan('R1642-happy', [`r1642-rev-a`]);

    const res = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(res.status).toBe(200);
    const after = await testPrisma.plan.findUnique({
      where: { id: planId },
      select: { status: true },
    });
    expect(after?.status).toBe('active');
  });

  it('closes #1642: outer gate sees all approved, concurrent reviewer-add lands BEFORE in-tx flip → 409, row stays proposed', async () => {
    // Race the #1642 finding called out:
    //   1. Route's outer L46 read returns plan.reviews=[{approved}],
    //      the review gate at L67–L87 passes.
    //   2. A concurrent reviewer-add (POST .../reviews or PATCH .../
    //      with requiredReviewers) commits a new pending PlanReview;
    //      plan.status stays 'proposed'.
    //   3. Pre-fix: in-tx `status: observedStatus` still matches
    //      ('proposed' === 'proposed'), updateMany flips the row to
    //      'active', and the just-added reviewer is silently bypassed.
    //   4. Post-fix: the route re-reads PlanReview inside the tx under
    //      `SELECT ... FOR UPDATE` on the plan row and re-evaluates the
    //      gate; the new pending row trips it, route 409s.
    //
    // The race is simulated deterministically via
    // spyOnProductionPrisma('plan', 'findUnique', ...): the patched
    // `plan.findUnique` (which `requirePlanInProject` calls at route
    // L46) injects a new pending PlanReview into the DB *before*
    // returning the original snapshot. By the time the tx's
    // `tx.planReview.findMany` re-read fires, the row is committed and
    // visible.
    const { planId } = await makeApprovedProposedPlan('R1642-race', [`r1642-rev-b`]);

    let racedOnce = false;
    const restoreSpy = await spyOnProductionPrisma('plan', 'findUnique', (orig) => {
      const original = orig as (...args: unknown[]) => Promise<unknown>;
      return ((args: unknown) => {
        const argRecord = args as { where?: { id?: string } } | undefined;
        if (!racedOnce && argRecord?.where?.id === planId) {
          racedOnce = true;
          return original(args).then(async (result) => {
            // Inject the pending reviewer between outer read and in-tx flip.
            await testPrisma.planReview.create({
              data: {
                planId,
                reviewerName: `r1642-rev-c`,
                status: 'pending',
              },
            });
            return result;
          });
        }
        return original(args);
      }) as never;
    });

    try {
      const res = await activatePost(
        makeReq(`/api/projects/${projectId}/plans/${planId}/activate`, {
          method: 'POST',
          userName: owner,
          body: {},
        }),
        { params: Promise.resolve({ projectId, planId }) },
      );
      expect(racedOnce).toBe(true);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error?.code).toBe('STATE_CONFLICT');
      // The error should name the reviewer mismatch so operators can
      // diagnose ("review gate was validated with N approved, plan now
      // has M reviewers, K not yet approved").
      expect(body.error?.message).toMatch(/reviewer/i);
    } finally {
      restoreSpy();
    }

    // Crucially: the row was NOT silently flipped to 'active'. Pre-fix
    // it would have been.
    const after = await testPrisma.plan.findUnique({
      where: { id: planId },
      select: { status: true },
    });
    expect(after?.status).toBe('proposed');

    // And the newly-added reviewer is still visible — we did not
    // accidentally roll back the concurrent commit.
    const reviews = await testPrisma.planReview.findMany({
      where: { planId },
      orderBy: { createdAt: 'asc' },
      select: { reviewerName: true, status: true },
    });
    expect(reviews.some((r) => r.reviewerName === `r1642-rev-c`)).toBe(true);
  });

  it('closes #1642: outer ?force=true with 0 reviewers, concurrent reviewer-add lands BEFORE in-tx flip → 409, row stays proposed', async () => {
    // The force-bypass mirror of the race:
    //   1. Outer L67–L87 takes the `force=true` branch because
    //      reviews.length === 0 at outer-read time.
    //   2. A concurrent reviewer-add commits a new pending PlanReview;
    //      plan.status stays 'proposed'.
    //   3. Pre-fix: in-tx status guard matches, the route activates a
    //      proposed plan with an unapproved reviewer — force should NOT
    //      be allowed to silently absorb a reviewer who appeared after
    //      the operator's force decision.
    //   4. Post-fix: in-tx re-read sees the new reviewer; even under
    //      `force=true`, txReviews.length !== 0 trips the gate.
    await resetDraftPlans(projectId);
    const create = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'R1642-force-race',
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
    // R-205 owner-self-review fallback creates 1 review; clear so the
    // outer gate takes the `force=true` branch.
    await testPrisma.planReview.deleteMany({ where: { planId } });

    let racedOnce = false;
    const restoreSpy = await spyOnProductionPrisma('plan', 'findUnique', (orig) => {
      const original = orig as (...args: unknown[]) => Promise<unknown>;
      return ((args: unknown) => {
        const argRecord = args as { where?: { id?: string } } | undefined;
        if (!racedOnce && argRecord?.where?.id === planId) {
          racedOnce = true;
          return original(args).then(async (result) => {
            await testPrisma.planReview.create({
              data: {
                planId,
                reviewerName: `r1642-late-reviewer`,
                status: 'pending',
              },
            });
            return result;
          });
        }
        return original(args);
      }) as never;
    });

    try {
      const res = await activatePost(
        makeReq(`/api/projects/${projectId}/plans/${planId}/activate?force=true`, {
          method: 'POST',
          userName: owner,
          body: {},
        }),
        { params: Promise.resolve({ projectId, planId }) },
      );
      expect(racedOnce).toBe(true);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error?.code).toBe('STATE_CONFLICT');
      // Force-branch error message specifically names the 0-vs-N
      // reviewer mismatch so operators see why force was overridden.
      expect(body.error?.message).toMatch(/reviewer/i);
      expect(body.error?.message).toMatch(/force/i);
    } finally {
      restoreSpy();
    }

    const after = await testPrisma.plan.findUnique({
      where: { id: planId },
      select: { status: true },
    });
    expect(after?.status).toBe('proposed');
  });

  it('static guard: activate route re-validates reviews under a plan-row FOR UPDATE inside the tx', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../src/app/api/projects/[projectId]/plans/[planId]/activate/route.ts',
      ),
      'utf-8',
    );
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // Lock must be a row-level FOR UPDATE on the plan row inside tx.
    expect(codeOnly).toMatch(/tx\.\$executeRaw[\s\S]*plans[\s\S]*FOR UPDATE/);
    // Reviews must be re-fetched inside tx (not just the outer plan.reviews).
    expect(codeOnly).toMatch(/tx\.planReview\.findMany/);
    // The Closes #1642 marker lives in a comment.
    expect(src).toMatch(/Closes #1642|#1642/);
  });
});

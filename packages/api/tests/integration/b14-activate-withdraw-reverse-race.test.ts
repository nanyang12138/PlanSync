/**
 * Closes #903 #984 #1167 — the activate ⇄ withdraw race in BOTH directions.
 *
 * #816 (PR #867) closed the withdraw-loses-to-activate direction by
 * scoping withdraw's update to `status: 'proposed'` so a concurrent
 * activate that already flipped the plan can't be reverted.
 *
 * The OPPOSITE direction was originally closed by #903 #984 (PR #1115)
 * with `updateMany({ status: { in: ['draft', 'proposed'] } })`. That
 * fix was incomplete: #1167 pointed out that a concrete withdraw race
 * (outer read sees 'proposed' → review-gate passes → concurrent
 * withdraw flips proposed→draft → in-tx updateMany still matches the
 * 'draft' row → silently activates a freshly-withdrawn plan whose
 * PlanReview rows were just deleted).
 *
 * The current fix tightens the in-tx guard to the EXACT status the
 * outer read observed (`status: plan.status`), so any mid-flight
 * transition that invalidates the pre-validated snapshot surfaces as
 * STATE_CONFLICT instead of silently flipping the wrong row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as plansPost } from '@/app/api/projects/[projectId]/plans/route';
import { POST as proposePost } from '@/app/api/projects/[projectId]/plans/[planId]/propose/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { POST as withdrawPost } from '@/app/api/projects/[projectId]/plans/[planId]/withdraw/route';
import {
  makeReq,
  createTestProject,
  cleanupProject,
  resetDraftPlans,
  testPrisma,
  spyOnProductionPrisma,
} from '../helpers/request';

describe('B14 / closes #903 #984 #1167 — activate cannot resurrect a withdrawn plan', () => {
  const owner = 'b14-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  /**
   * Helper — propose a plan, returning its id. Each call resets pre-existing
   * draft/proposed plans to 'superseded' so the R-134 "one draft per project"
   * guard doesn't 409 the second/third call within this suite.
   */
  async function makeProposedPlan(title: string): Promise<string> {
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
        body: { reviewers: [] },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(propose.status).toBe(200);
    return planId;
  }

  it('legitimate withdraw → re-propose → withdraw → activate(?force) still succeeds (no false 409)', async () => {
    // Sanity check for the happy path: when withdraw lands BEFORE the
    // activate route's outer read, the route observes 'draft', the
    // in-tx guard requires 'draft', and the update succeeds. The
    // #1167 fix must not regress this legitimate flow.
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
    expect((await testPrisma.plan.findUnique({ where: { id: planId } }))?.status).toBe('draft');

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
    expect(
      (await testPrisma.plan.findUnique({ where: { id: planId }, select: { status: true } }))
        ?.status,
    ).toBe('draft');

    const goodActivate = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/activate?force=true`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(goodActivate.status).toBe(200);
    expect((await testPrisma.plan.findUnique({ where: { id: planId } }))?.status).toBe('active');
  });

  it('activate with stale outer-read snapshot (DB row already superseded) → 4xx, row stays superseded', async () => {
    // Drives the OUTER L50 guard (plan.status !== 'draft' &&
    // plan.status !== 'proposed'). Pre-#903/#984 the in-tx bare
    // `update` would silently flip even a superseded row back to
    // active because the outer guard read was stale; with the
    // current code the outer guard rejects on the freshly-read
    // 'superseded' status, but we keep the assertion here as a
    // belt-and-braces regression check for any future refactor.
    const planId = await makeProposedPlan('B14-stale-snapshot');

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
    expect(after?.status).toBe('superseded');
  });

  it('closes #1167: in-tx race — outer read sees proposed, withdraw lands BEFORE in-tx update → STATE_CONFLICT, row stays draft', async () => {
    // The exact race the #1167 finding called out:
    //   1. Route's outer read (requirePlanInProject → prisma.plan.findUnique)
    //      sees status='proposed' and passes the review/force gate.
    //   2. A concurrent withdraw lands BEFORE the in-tx updateMany
    //      executes, flipping the row to 'draft' AND deleting all
    //      PlanReview rows.
    //   3. With the previous guard `status in ['draft', 'proposed']`,
    //      the in-tx updateMany still matched the now-'draft' row and
    //      silently activated a plan whose review gate evaluation was
    //      already stale — a "draft" without the legitimate gate
    //      drafts go through, AND a freshly-withdrawn plan.
    //   4. With the #1167 fix (`status: plan.status === 'proposed'`),
    //      the in-tx update no longer matches the 'draft' row and the
    //      route surfaces STATE_CONFLICT instead.
    //
    // We simulate the race deterministically by patching the
    // production prisma singleton's `plan.findUnique` — that's the
    // call requirePlanInProject makes at route L46. The patched call
    // returns the genuine 'proposed' snapshot AND, before returning,
    // flips the underlying row to 'draft' (simulating a concurrent
    // withdraw landing between L46 and the in-tx updateMany). The
    // route's review-gate then evaluates against the stale 'proposed'
    // snapshot, enters the tx, and the new in-tx guard rejects.
    const planId = await makeProposedPlan('B14-1167-in-tx-race');

    // R-205 auto-adds the owner as sole reviewer when the propose
    // call omits reviewers, so plan.reviews.length === 1 (pending)
    // by default. To drive the in-tx race deterministically we
    // need the route to reach the in-tx update, which means
    // skipping the review-gate via the zero-reviewers + ?force=true
    // path. Clear the auto-added review row before activate fires.
    await testPrisma.planReview.deleteMany({ where: { planId } });

    // Confirm the proposed snapshot before we patch findUnique.
    const baseline = await testPrisma.plan.findUnique({
      where: { id: planId },
      select: { status: true },
    });
    expect(baseline?.status).toBe('proposed');

    let racedOnce = false;
    const restoreSpy = await spyOnProductionPrisma('plan', 'findUnique', (orig) => {
      const original = orig as (...args: unknown[]) => Promise<unknown>;
      return ((args: unknown) => {
        const argRecord = args as { where?: { id?: string } } | undefined;
        if (!racedOnce && argRecord?.where?.id === planId) {
          racedOnce = true;
          return original(args).then(async (result) => {
            // Simulate a concurrent withdraw that lands AFTER the
            // outer read returned a 'proposed' snapshot but BEFORE
            // the activate's in-tx updateMany executes.
            await testPrisma.plan.update({
              where: { id: planId },
              data: { status: 'draft' },
            });
            await testPrisma.planReview.deleteMany({ where: { planId } });
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

      // Pre-#1167-fix: this would return 200 because the in-tx
      // updateMany `{ status: { in: ['draft', 'proposed'] } }`
      // matched the 'draft' row that withdraw left behind.
      // Post-fix: the in-tx guard requires `status: 'proposed'`
      // (the observed snapshot), the now-'draft' row doesn't
      // match, count===0, route throws STATE_CONFLICT.
      expect(racedOnce).toBe(true);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error?.code).toBe('STATE_CONFLICT');
      // The error message must mention the stale 'proposed'
      // snapshot AND the current 'draft' state so operators can
      // diagnose; otherwise they'd be left guessing why activate
      // failed on what they think is a proposed plan.
      expect(body.error?.message).toMatch(/'proposed'/);
      expect(body.error?.message).toMatch(/'draft'/);
    } finally {
      restoreSpy();
    }

    // Crucially: the row was NOT silently flipped to 'active'.
    // Pre-fix it would have been.
    const after = await testPrisma.plan.findUnique({
      where: { id: planId },
      select: { status: true },
    });
    expect(after?.status).toBe('draft');
  });

  it('closes #1167: in-tx race — outer read sees draft, propose lands BEFORE in-tx update → STATE_CONFLICT, row stays proposed', async () => {
    // The mirror direction of the race: route observes 'draft'
    // (legitimately activatable per L50), then a concurrent propose
    // flips it to 'proposed' (which may add brand-new reviewers
    // the route never evaluated). The previous guard
    // `status in ['draft', 'proposed']` would still match and
    // activate, bypassing whatever review state the propose
    // pathway just established. The fix's `status: plan.status`
    // ('draft' here) rejects the now-'proposed' row.
    const planId = await makeProposedPlan('B14-1167-draft-to-proposed');
    // Move the plan back to draft so the outer read sees 'draft'.
    await withdrawPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/withdraw`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(
      (await testPrisma.plan.findUnique({ where: { id: planId }, select: { status: true } }))
        ?.status,
    ).toBe('draft');

    let racedOnce = false;
    const restoreSpy = await spyOnProductionPrisma('plan', 'findUnique', (orig) => {
      const original = orig as (...args: unknown[]) => Promise<unknown>;
      return ((args: unknown) => {
        const argRecord = args as { where?: { id?: string } } | undefined;
        if (!racedOnce && argRecord?.where?.id === planId) {
          racedOnce = true;
          return original(args).then(async (result) => {
            // Simulate a concurrent propose landing between the
            // outer read and the in-tx updateMany.
            await testPrisma.plan.update({
              where: { id: planId },
              data: { status: 'proposed' },
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
      expect(body.error?.message).toMatch(/'draft'/);
      expect(body.error?.message).toMatch(/'proposed'/);
    } finally {
      restoreSpy();
    }

    const after = await testPrisma.plan.findUnique({
      where: { id: planId },
      select: { status: true },
    });
    expect(after?.status).toBe('proposed');
  });

  it('static guard: activate route in-tx update is scoped to the observed snapshot, not the union', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../src/app/api/projects/[projectId]/plans/[planId]/activate/route.ts',
      ),
      'utf-8',
    );
    // The flip MUST be `updateMany` inside the $transaction, with
    // the `status` guard pinned to the observed-snapshot value, and
    // a count===0 → STATE_CONFLICT branch. The previous union form
    // `status: { in: ['draft', 'proposed'] }` is exactly what #1167
    // rejected; if it ever reappears in CODE (not comments), this
    // assertion fails fast.
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).toMatch(/tx\.plan\.updateMany\(/);
    expect(codeOnly).toMatch(/status:\s*observedStatus/);
    expect(codeOnly).not.toMatch(/status:\s*\{\s*in:\s*\[\s*['"]draft['"]/);
    expect(codeOnly).toMatch(/flip\.count\s*===\s*0/);
    // The "Closes #" tag intentionally lives in a comment — search
    // the raw source for it.
    expect(src).toMatch(/Closes #903 #984 #1167/);
  });
});

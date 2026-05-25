// R-048: Enforce at most one Plan with status='active' per project via a
// partial unique index `plans_one_active_per_project`. The activate route
// maps the resulting Prisma P2002 to a 409 STATE_CONFLICT response.
//
// Two layers of protection are tested here:
//   1. The DB-level partial unique index rejects a raw second `active` insert.
//   2. End-to-end: concurrent activate requests on two proposed plans always
//      converge to a single active row — the user-visible invariant holds
//      regardless of which serialisation the DB chooses.
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
} from '../helpers/request';

describe('R-048: at most one active plan per project', () => {
  const owner = 'r048-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  async function clearActive() {
    await testPrisma.plan.updateMany({
      where: { projectId, status: 'active' },
      data: { status: 'superseded' },
    });
  }

  async function createProposedPlan(title: string): Promise<{ id: string; version: number }> {
    await resetDraftPlans(projectId);
    const created = await plansPost(
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
    expect(created.status).toBe(201);
    const plan = (await created.json()).data as { id: string; version: number };

    const proposed = await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${plan.id}/propose`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, planId: plan.id }) },
    );
    expect(proposed.status).toBe(200);

    // R-205: propose now auto-adds the owner as the sole reviewer when no
    // reviewer set is supplied. To exercise the R-048 concurrency code path
    // without depending on `?force=true`, mark the owner-self review as
    // approved directly so the activate route's review-gate check passes.
    await testPrisma.planReview.updateMany({
      where: { planId: plan.id },
      data: { status: 'approved' },
    });

    return plan;
  }

  it('partial unique index rejects a second `active` row for the same project (P2002)', async () => {
    await clearActive();

    const first = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'R-048 raw a',
        goal: 'g',
        scope: 's',
        version: 9001,
        status: 'active',
        createdBy: owner,
        activatedAt: new Date(),
        activatedBy: owner,
      },
    });

    let caught: { code?: string } | null = null;
    try {
      await testPrisma.plan.create({
        data: {
          projectId,
          title: 'R-048 raw b',
          goal: 'g',
          scope: 's',
          version: 9002,
          status: 'active',
          createdBy: owner,
          activatedAt: new Date(),
          activatedBy: owner,
        },
      });
    } catch (err) {
      caught = err as { code?: string };
    }
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe('P2002');

    // Once the first row is removed (or moved off `active`), a fresh insert
    // must succeed — i.e. the index is partial, not a plain unique.
    await testPrisma.plan.update({
      where: { id: first.id },
      data: { status: 'superseded' },
    });
    const second = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'R-048 raw c',
        goal: 'g',
        scope: 's',
        version: 9003,
        status: 'active',
        createdBy: owner,
        activatedAt: new Date(),
        activatedBy: owner,
      },
    });
    expect(second.status).toBe('active');
    await testPrisma.plan.delete({ where: { id: second.id } });
    await testPrisma.plan.delete({ where: { id: first.id } });
  });

  it('concurrent activate of two proposed plans → exactly one active row remains', async () => {
    await clearActive();

    const a = await createProposedPlan('R-048 plan A');
    const b = await createProposedPlan('R-048 plan B');

    // Both proposed plans have an approved owner-self review (R-205). They
    // pass the review gate, so this test exercises the R-048 concurrency
    // code path instead of being rejected upstream.
    const [ra, rb] = await Promise.all([
      activatePost(
        makeReq(`/api/projects/${projectId}/plans/${a.id}/activate`, {
          method: 'POST',
          userName: owner,
        }),
        { params: Promise.resolve({ projectId, planId: a.id }) },
      ),
      activatePost(
        makeReq(`/api/projects/${projectId}/plans/${b.id}/activate`, {
          method: 'POST',
          userName: owner,
        }),
        { params: Promise.resolve({ projectId, planId: b.id }) },
      ),
    ]);

    // The route's own `updateMany({status: 'superseded'})` makes user-visible
    // serial activate calls both succeed (the second one supersedes the
    // first). What R-048 buys us is the DB-level safety net for the truly
    // interleaved case: at no point can there be two rows with status='active'
    // for the same projectId.
    const okCount = [ra, rb].filter((r) => r.status === 200).length;
    expect(okCount).toBeGreaterThanOrEqual(1);

    // The 409 path (if taken) MUST carry STATE_CONFLICT — that is the new
    // contract introduced by this PR. (Generic CONFLICT from the default
    // Prisma error mapping would be a regression.)
    for (const r of [ra, rb]) {
      if (r.status !== 200) {
        expect(r.status).toBe(409);
        const body = await r.json();
        expect(body.error.code).toBe('STATE_CONFLICT');
      }
    }

    const activeRows = await testPrisma.plan.findMany({
      where: { projectId, status: 'active' },
    });
    expect(activeRows).toHaveLength(1);
  });
});

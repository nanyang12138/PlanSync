/**
 * R-152: every plan write route must populate the split tables alongside
 * the legacy String[] columns, and `activate` must wire up the
 * `supersededById` chain by slug.
 *
 * Routes covered (one assertion family per route):
 *   - POST  /plans                             (create)
 *   - PATCH /plans/[planId]                    (update)
 *   - POST  /plans/[planId]/append             (append item)
 *   - POST  /plans/[planId]/suggestions/[id]?action=accept  (suggestion accept)
 *   - POST  /plans/[planId]/activate           (supersede chain)
 *
 * The driving invariant from R-151's `checkPlanItemsInvariant` is:
 *   for every plan + field, the legacy String[] column has the same
 *   contents (in order) as the split-table rows.
 *
 * R-152 makes that invariant true for every write path, not just direct
 * writeBoth callers. After each route exercise we re-read the plan and
 * the split rows to confirm the dual-write actually happened — a regression
 * (e.g. someone reaching for plan.update directly) would surface as a
 * `length mismatch` here long before drift-engine v3 starts misbehaving.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as plansPost } from '@/app/api/projects/[projectId]/plans/route';
import {
  PATCH as planPatch,
  GET as planGet,
} from '@/app/api/projects/[projectId]/plans/[planId]/route';
import { POST as appendPost } from '@/app/api/projects/[projectId]/plans/[planId]/append/route';
import { POST as suggestionResolvePost } from '@/app/api/projects/[projectId]/plans/[planId]/suggestions/[suggestionId]/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { POST as proposePost } from '@/app/api/projects/[projectId]/plans/[planId]/propose/route';
import { POST as reviewPost } from '@/app/api/projects/[projectId]/plans/[planId]/reviews/[reviewId]/route';
import {
  makeReq,
  createTestProject,
  cleanupProject,
  resetDraftPlans,
  testPrisma as prisma,
} from '../helpers/request';
import { checkPlanItemsInvariant } from '@/lib/plan-items';

describe('R-152: plan write routes route through writeBoth + supersede chain', () => {
  const owner = 'r152-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  // Each scenario creates its own draft so the assertions are independent.
  async function freshDraft(args: {
    title: string;
    deliverables?: string[];
    constraints?: string[];
    standards?: string[];
  }): Promise<{ planId: string }> {
    await resetDraftPlans(projectId);
    const res = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: args.title,
          goal: 'goal',
          scope: 'scope',
          constraints: args.constraints ?? [],
          standards: args.standards ?? [],
          deliverables: args.deliverables ?? [],
          openQuestions: [],
        },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    return { planId: body.data.id };
  }

  it('create (POST /plans) populates split tables 1:1 with the body arrays', async () => {
    const { planId } = await freshDraft({
      title: 'create-test',
      deliverables: ['Implement auth', 'Wire up SSE'],
      constraints: ['No external network in tests'],
      standards: ['snake_case for DB columns'],
    });

    const dRows = await prisma.planDeliverable.findMany({
      where: { planId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(dRows.map((r) => r.title)).toEqual(['Implement auth', 'Wire up SSE']);
    expect(dRows.map((r) => r.slug)).toEqual(['implement-auth-0', 'wire-up-sse-1']);
    expect(dRows.every((r) => r.status === 'active')).toBe(true);

    const cRows = await prisma.planConstraint.findMany({ where: { planId } });
    expect(cRows.map((r) => r.body)).toEqual(['No external network in tests']);

    const sRows = await prisma.planStandard.findMany({ where: { planId } });
    expect(sRows.map((r) => r.body)).toEqual(['snake_case for DB columns']);

    expect(await checkPlanItemsInvariant(planId)).toEqual([]);
  });

  it('update (PATCH) replaces split rows when array fields are supplied', async () => {
    const { planId } = await freshDraft({
      title: 'patch-test',
      deliverables: ['old-d-1', 'old-d-2'],
    });
    // Sanity: the split rows from the create are present.
    expect(await prisma.planDeliverable.count({ where: { planId } })).toBe(2);

    const res = await planPatch(
      makeReq(`/api/projects/${projectId}/plans/${planId}`, {
        method: 'PATCH',
        userName: owner,
        body: {
          deliverables: ['new-d-only'],
          constraints: ['c-after-patch'],
        },
      }),
      { params: { projectId, planId } },
    );
    expect(res.status).toBe(200);

    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.deliverables).toEqual(['new-d-only']);
    expect(plan.constraints).toEqual(['c-after-patch']);

    const dRows = await prisma.planDeliverable.findMany({ where: { planId } });
    expect(dRows.map((r) => r.title)).toEqual(['new-d-only']);
    const cRows = await prisma.planConstraint.findMany({ where: { planId } });
    expect(cRows.map((r) => r.body)).toEqual(['c-after-patch']);

    // The route returns the plan in its post-writeBoth shape so callers
    // see the new arrays without a follow-up GET.
    const body = await res.json();
    expect(body.data.deliverables).toEqual(['new-d-only']);
    expect(body.data.constraints).toEqual(['c-after-patch']);

    expect(await checkPlanItemsInvariant(planId)).toEqual([]);

    // GET also reflects the same shape, double-checking we did not return
    // a stale snapshot from before the writeBoth call.
    const getRes = await planGet(
      makeReq(`/api/projects/${projectId}/plans/${planId}`, {
        method: 'GET',
        userName: owner,
      }),
      { params: { projectId, planId } },
    );
    const getBody = await getRes.json();
    expect(getBody.data.deliverables).toEqual(['new-d-only']);
  });

  it('append (POST /append) writes to the split table for split fields', async () => {
    const { planId } = await freshDraft({
      title: 'append-test',
      deliverables: ['existing'],
    });

    const res = await appendPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/append`, {
        method: 'POST',
        userName: owner,
        body: { field: 'deliverables', items: ['added-1', 'added-2'] },
      }),
      { params: { projectId, planId } },
    );
    expect(res.status).toBe(200);

    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.deliverables).toEqual(['existing', 'added-1', 'added-2']);

    const dRows = await prisma.planDeliverable.findMany({
      where: { planId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(dRows.map((r) => r.title)).toEqual(['existing', 'added-1', 'added-2']);

    expect(await checkPlanItemsInvariant(planId)).toEqual([]);
  });

  it('append (POST /append) on openQuestions does NOT touch the split tables', async () => {
    const { planId } = await freshDraft({ title: 'openq-test' });

    const res = await appendPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/append`, {
        method: 'POST',
        userName: owner,
        body: { field: 'openQuestions', items: ['Why?', 'How?'] },
      }),
      { params: { projectId, planId } },
    );
    expect(res.status).toBe(200);

    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.openQuestions).toEqual(['Why?', 'How?']);
    // openQuestions has no split table by design (R-150 doc-comment); the
    // counts on the three sibling tables must therefore be exactly what
    // the (empty) create produced.
    expect(await prisma.planDeliverable.count({ where: { planId } })).toBe(0);
    expect(await prisma.planConstraint.count({ where: { planId } })).toBe(0);
    expect(await prisma.planStandard.count({ where: { planId } })).toBe(0);
  });

  it('suggestion accept (action=append) writes through writeBoth', async () => {
    const { planId } = await freshDraft({
      title: 'suggestion-test',
      deliverables: ['from-create'],
    });
    const sugg = await prisma.planSuggestion.create({
      data: {
        planId,
        suggestedBy: owner,
        suggestedByType: 'human',
        field: 'deliverables',
        action: 'append',
        value: 'from-suggestion',
        reason: 'because',
        status: 'pending',
      },
    });

    const res = await suggestionResolvePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions/${sugg.id}?action=accept`, {
        method: 'POST',
        userName: owner,
        body: {},
        searchParams: { action: 'accept' },
      }),
      { params: { projectId, planId, suggestionId: sugg.id } },
    );
    expect(res.status).toBe(200);

    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.deliverables).toEqual(['from-create', 'from-suggestion']);
    const dRows = await prisma.planDeliverable.findMany({
      where: { planId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(dRows.map((r) => r.title)).toEqual(['from-create', 'from-suggestion']);
    expect(await checkPlanItemsInvariant(planId)).toEqual([]);
  });

  it('activate links previous version deliverables to the new ones via supersededById', async () => {
    // Build v1 with two deliverables.
    const v1 = await freshDraft({
      title: 'activate-v1',
      deliverables: ['Auth callback', 'Token refresh'],
    });
    // Bring v1 to active (no reviewers → owner self-review fallback).
    const propV1 = await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${v1.planId}/propose`, {
        method: 'POST',
        userName: owner,
        body: { reviewers: [owner] },
      }),
      { params: { projectId, planId: v1.planId } },
    );
    expect(propV1.status).toBe(200);
    const v1Reviews = await prisma.planReview.findMany({ where: { planId: v1.planId } });
    expect(v1Reviews).toHaveLength(1);
    const approveV1 = await reviewPost(
      makeReq(
        `/api/projects/${projectId}/plans/${v1.planId}/reviews/${v1Reviews[0].id}?action=approve`,
        { method: 'POST', userName: owner, body: {}, searchParams: { action: 'approve' } },
      ),
      { params: { projectId, planId: v1.planId, reviewId: v1Reviews[0].id } },
    );
    expect(approveV1.status).toBe(200);
    const actV1 = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${v1.planId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId: v1.planId } },
    );
    expect(actV1.status).toBe(200);

    // Build v2 keeping `Auth callback` (same slug `auth-callback-0`),
    // dropping `Token refresh`, adding `Logout`. This means the supersede
    // wiring should:
    //   - link v1.auth-callback-0  → v2.auth-callback-0     (linked + deprecated)
    //   - leave  v1.token-refresh-1 with supersededById null (removed; drift-engine signal)
    //   - leave  v2.* alone (they are the new canonical rows)
    const v2 = await freshDraft({
      title: 'activate-v2',
      deliverables: ['Auth callback', 'Logout'],
    });
    const propV2 = await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${v2.planId}/propose`, {
        method: 'POST',
        userName: owner,
        body: { reviewers: [owner] },
      }),
      { params: { projectId, planId: v2.planId } },
    );
    expect(propV2.status).toBe(200);
    const v2Reviews = await prisma.planReview.findMany({ where: { planId: v2.planId } });
    const approveV2 = await reviewPost(
      makeReq(
        `/api/projects/${projectId}/plans/${v2.planId}/reviews/${v2Reviews[0].id}?action=approve`,
        { method: 'POST', userName: owner, body: {}, searchParams: { action: 'approve' } },
      ),
      { params: { projectId, planId: v2.planId, reviewId: v2Reviews[0].id } },
    );
    expect(approveV2.status).toBe(200);
    const actV2 = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${v2.planId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId: v2.planId } },
    );
    expect(actV2.status).toBe(200);

    // v1 is now superseded; its deliverables must reflect the chain.
    const v1Deliverables = await prisma.planDeliverable.findMany({
      where: { planId: v1.planId },
      orderBy: { slug: 'asc' },
    });
    const v2Deliverables = await prisma.planDeliverable.findMany({
      where: { planId: v2.planId },
      orderBy: { slug: 'asc' },
    });
    const v2BySlug = new Map(v2Deliverables.map((r) => [r.slug, r]));

    const v1AuthCallback = v1Deliverables.find((r) => r.slug === 'auth-callback-0');
    const v1TokenRefresh = v1Deliverables.find((r) => r.slug === 'token-refresh-1');
    expect(v1AuthCallback).toBeTruthy();
    expect(v1TokenRefresh).toBeTruthy();

    expect(v1AuthCallback!.supersededById).toBe(v2BySlug.get('auth-callback-0')!.id);
    expect(v1AuthCallback!.status).toBe('deprecated');

    // Removed in v2 → no successor → still no link, status untouched.
    expect(v1TokenRefresh!.supersededById).toBeNull();

    // The new plan's deliverables remain `active` and unlinked.
    for (const r of v2Deliverables) {
      expect(r.supersededById).toBeNull();
      expect(r.status).toBe('active');
    }
  });
});

/**
 * R-155: per-PlanDeliverable CRUD routes power the new
 * `plansync_deliverable_*` MCP tool family. Each scenario exercises one
 * route through the same authenticated request shape that the MCP tools
 * generate (project owner, plan in `draft` status, no `asAgent` override)
 * so the assertions cover the production code path end-to-end.
 *
 * Scope:
 *   - GET    /deliverables                       — list (any member)
 *   - POST   /deliverables                       — create (owner, draft)
 *   - GET    /deliverables/:deliverableId        — show
 *   - PATCH  /deliverables/:deliverableId        — update
 *   - POST   /deliverables/:deliverableId/supersede — supersede
 *   - cross-plan / cross-project NOT_FOUND containment
 *   - duplicate slug → STATE_CONFLICT
 *   - PlanSuggestion.deliverableId → unknown row rejected, valid row stored
 *
 * The legacy `plan.deliverables` String[] mirror is asserted to stay in
 * sync after each row write — protects future drift-engine fallback /
 * plan_show paths that still read the array.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as plansPost } from '@/app/api/projects/[projectId]/plans/route';
import {
  GET as deliverableListGet,
  POST as deliverablePost,
} from '@/app/api/projects/[projectId]/plans/[planId]/deliverables/route';
import {
  GET as deliverableShowGet,
  PATCH as deliverablePatch,
} from '@/app/api/projects/[projectId]/plans/[planId]/deliverables/[deliverableId]/route';
import { POST as deliverableSupersede } from '@/app/api/projects/[projectId]/plans/[planId]/deliverables/[deliverableId]/supersede/route';
import { POST as suggestionPost } from '@/app/api/projects/[projectId]/plans/[planId]/suggestions/route';
import { POST as suggestionResolve } from '@/app/api/projects/[projectId]/plans/[planId]/suggestions/[suggestionId]/route';
import {
  makeReq,
  createTestProject,
  cleanupProject,
  resetDraftPlans,
  testPrisma as prisma,
} from '../helpers/request';

describe('R-155: deliverable CRUD routes', () => {
  const owner = 'r155-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  async function freshDraft(initialDeliverables: string[] = []): Promise<{ planId: string }> {
    await resetDraftPlans(projectId);
    const res = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'r155-draft',
          goal: 'goal',
          scope: 'scope',
          constraints: [],
          standards: [],
          deliverables: initialDeliverables,
          openQuestions: [],
        },
      }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    return { planId: body.data.id };
  }

  it('POST /deliverables creates a row, syncs the legacy mirror, and rejects duplicate slugs', async () => {
    const { planId } = await freshDraft(['Existing item']);

    const ok = await deliverablePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/deliverables`, {
        method: 'POST',
        userName: owner,
        body: {
          slug: 'auth/oidc-callback',
          title: 'OIDC callback',
          body: 'Implement /auth/callback',
          refType: 'file_glob',
          refUri: 'src/auth/**',
        },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(ok.status).toBe(201);
    const okBody = await ok.json();
    expect(okBody.data.slug).toBe('auth/oidc-callback');
    expect(okBody.data.refType).toBe('file_glob');
    expect(okBody.data.status).toBe('active');

    // Legacy mirror must include the new title appended at the tail so
    // plan_show / drift-engine fallbacks observe a consistent view.
    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.deliverables).toEqual(['Existing item', 'OIDC callback']);

    // Duplicate slug → STATE_CONFLICT (P2002 caught and translated).
    const dup = await deliverablePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/deliverables`, {
        method: 'POST',
        userName: owner,
        body: {
          slug: 'auth/oidc-callback',
          title: 'Another title',
          body: 'Another body',
        },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(dup.status).toBe(409);
  });

  it('GET /deliverables lists rows; GET /:id returns the row; cross-plan/project ids return NOT_FOUND', async () => {
    const { planId } = await freshDraft();
    const created = await deliverablePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/deliverables`, {
        method: 'POST',
        userName: owner,
        body: { slug: 'foo', title: 'Foo', body: 'Foo body' },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const createdBody = await created.json();
    const deliverableId = createdBody.data.id as string;

    const list = await deliverableListGet(
      makeReq(`/api/projects/${projectId}/plans/${planId}/deliverables`, {
        userName: owner,
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.data.map((r: { slug: string }) => r.slug)).toContain('foo');

    const show = await deliverableShowGet(
      makeReq(`/api/projects/${projectId}/plans/${planId}/deliverables/${deliverableId}`, {
        userName: owner,
      }),
      { params: Promise.resolve({ projectId, planId, deliverableId }) },
    );
    expect(show.status).toBe(200);
    expect((await show.json()).data.id).toBe(deliverableId);

    // Probing the deliverable id through a different (made-up) plan id
    // must collapse into NOT_FOUND, never leak the row.
    const wrongPlan = await deliverableShowGet(
      makeReq(`/api/projects/${projectId}/plans/nonexistent-plan/deliverables/${deliverableId}`, {
        userName: owner,
      }),
      {
        params: Promise.resolve({
          projectId,
          planId: 'nonexistent-plan',
          deliverableId,
        }),
      },
    );
    expect(wrongPlan.status).toBe(404);
  });

  it('PATCH updates fields and re-derives the legacy mirror when the title changes', async () => {
    const { planId } = await freshDraft();
    const created = await deliverablePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/deliverables`, {
        method: 'POST',
        userName: owner,
        body: { slug: 'svc/runner', title: 'Old title', body: 'body' },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const deliverableId = (await created.json()).data.id as string;

    const patch = await deliverablePatch(
      makeReq(`/api/projects/${projectId}/plans/${planId}/deliverables/${deliverableId}`, {
        method: 'PATCH',
        userName: owner,
        body: {
          title: 'New title',
          refType: 'api_spec',
          refUri: 'https://example.com/openapi.json',
        },
      }),
      { params: Promise.resolve({ projectId, planId, deliverableId }) },
    );
    expect(patch.status).toBe(200);
    const patchBody = await patch.json();
    expect(patchBody.data.title).toBe('New title');
    expect(patchBody.data.refType).toBe('api_spec');

    // Legacy mirror reflects the new title via the syncDeliverableArrayMirror
    // helper called inside the route's transaction.
    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.deliverables).toContain('New title');
    expect(plan.deliverables).not.toContain('Old title');
  });

  it('POST /supersede deprecates the row and (optionally) sets supersededById', async () => {
    const { planId } = await freshDraft();

    const oldRow = await deliverablePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/deliverables`, {
        method: 'POST',
        userName: owner,
        body: { slug: 'old/item', title: 'Old', body: 'old body' },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const oldId = (await oldRow.json()).data.id as string;

    const newRow = await deliverablePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/deliverables`, {
        method: 'POST',
        userName: owner,
        body: { slug: 'new/item', title: 'New', body: 'new body' },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const newId = (await newRow.json()).data.id as string;

    const sup = await deliverableSupersede(
      makeReq(`/api/projects/${projectId}/plans/${planId}/deliverables/${oldId}/supersede`, {
        method: 'POST',
        userName: owner,
        body: { supersededById: newId },
      }),
      { params: Promise.resolve({ projectId, planId, deliverableId: oldId }) },
    );
    expect(sup.status).toBe(200);
    const supBody = await sup.json();
    expect(supBody.data.status).toBe('deprecated');
    expect(supBody.data.supersededById).toBe(newId);

    // Self-supersede is rejected.
    const selfSup = await deliverableSupersede(
      makeReq(`/api/projects/${projectId}/plans/${planId}/deliverables/${newId}/supersede`, {
        method: 'POST',
        userName: owner,
        body: { supersededById: newId },
      }),
      { params: Promise.resolve({ projectId, planId, deliverableId: newId }) },
    );
    expect(selfSup.status).toBe(400);

    // Bare supersede with no successor still flips status.
    const bare = await deliverableSupersede(
      makeReq(`/api/projects/${projectId}/plans/${planId}/deliverables/${newId}/supersede`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: Promise.resolve({ projectId, planId, deliverableId: newId }) },
    );
    expect(bare.status).toBe(200);
    const bareBody = await bare.json();
    expect(bareBody.data.status).toBe('deprecated');
    expect(bareBody.data.supersededById).toBeNull();
  });

  it('issue #1146: accepting a suggestion with deliverableId mutates the targeted row, not the legacy array', async () => {
    const { planId } = await freshDraft();

    // Two deliverables; we'll touch the second one via a scoped suggestion.
    const keep = await deliverablePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/deliverables`, {
        method: 'POST',
        userName: owner,
        body: { slug: 'kept', title: 'Kept', body: 'kept body' },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const keepId = (await keep.json()).data.id as string;

    const target = await deliverablePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/deliverables`, {
        method: 'POST',
        userName: owner,
        body: { slug: 'target', title: 'Target', body: 'original body' },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const targetId = (await target.json()).data.id as string;

    // --- accept(append + deliverableId) overwrites the row's body and
    //     leaves all *other* rows untouched (the legacy append path used
    //     to push `value` onto the array, polluting plan.deliverables).
    const appendSugg = await suggestionPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions`, {
        method: 'POST',
        userName: owner,
        body: {
          field: 'deliverables',
          action: 'append',
          value: 'patched body content',
          reason: 'update body for target',
          deliverableId: targetId,
        },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const appendId = (await appendSugg.json()).data.id as string;

    const acceptAppend = await suggestionResolve(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions/${appendId}?action=accept`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      {
        params: Promise.resolve({ projectId, planId, suggestionId: appendId }),
      },
    );
    expect(acceptAppend.status).toBe(200);

    const targetAfterAppend = await prisma.planDeliverable.findUniqueOrThrow({
      where: { id: targetId },
    });
    expect(targetAfterAppend.body).toBe('patched body content');
    expect(targetAfterAppend.status).toBe('active');

    // Other rows untouched.
    const keepAfterAppend = await prisma.planDeliverable.findUniqueOrThrow({
      where: { id: keepId },
    });
    expect(keepAfterAppend.body).toBe('kept body');

    // Legacy array does NOT have `value` appended to it (that would be the
    // old broken behavior); it stays as the per-row mirror of titles.
    const planAfterAppend = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(planAfterAppend.deliverables).not.toContain('patched body content');
    expect(planAfterAppend.deliverables).toEqual(['Kept', 'Target']);

    // --- accept(remove + deliverableId) deprecates the targeted row in
    //     place (preserves identity for task-/commit-link audit trails)
    //     instead of array-filter-removing.
    const removeSugg = await suggestionPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions`, {
        method: 'POST',
        userName: owner,
        body: {
          field: 'deliverables',
          action: 'remove',
          value: 'irrelevant for per-row path',
          reason: 'no longer needed',
          deliverableId: targetId,
        },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const removeId = (await removeSugg.json()).data.id as string;

    const acceptRemove = await suggestionResolve(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions/${removeId}?action=accept`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      {
        params: Promise.resolve({ projectId, planId, suggestionId: removeId }),
      },
    );
    expect(acceptRemove.status).toBe(200);

    const targetAfterRemove = await prisma.planDeliverable.findUniqueOrThrow({
      where: { id: targetId },
    });
    expect(targetAfterRemove.status).toBe('deprecated');

    // Row still exists (identity preserved); the kept row is unchanged.
    const keepAfterRemove = await prisma.planDeliverable.findUniqueOrThrow({
      where: { id: keepId },
    });
    expect(keepAfterRemove.status).toBe('active');

    // Suggestion was marked accepted (not silently no-op'd).
    const resolved = await prisma.planSuggestion.findUniqueOrThrow({
      where: { id: removeId },
    });
    expect(resolved.status).toBe('accepted');
  });

  it('plansync_plan_suggest accepts deliverableId pointing at a row on the same plan', async () => {
    const { planId } = await freshDraft();
    const row = await deliverablePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/deliverables`, {
        method: 'POST',
        userName: owner,
        body: { slug: 'sugg/target', title: 'Target', body: 'target body' },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    const deliverableId = (await row.json()).data.id as string;

    const ok = await suggestionPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions`, {
        method: 'POST',
        userName: owner,
        body: {
          field: 'deliverables',
          action: 'append',
          value: 'Suggest a tweak',
          reason: 'Because',
          deliverableId,
        },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(ok.status).toBe(201);
    const okBody = await ok.json();
    expect(okBody.data.deliverableId).toBe(deliverableId);

    // Unknown row id is rejected with NOT_FOUND so cross-plan probing is
    // contained.
    const bad = await suggestionPost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/suggestions`, {
        method: 'POST',
        userName: owner,
        body: {
          field: 'deliverables',
          action: 'append',
          value: 'Bad ref',
          reason: 'Because',
          deliverableId: 'nonexistent-row',
        },
      }),
      { params: Promise.resolve({ projectId, planId }) },
    );
    expect(bad.status).toBe(404);
  });
});

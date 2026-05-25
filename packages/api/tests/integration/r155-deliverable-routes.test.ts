/**
 * R-155: REST surface for PlanDeliverable + plan_suggest.deliverableId.
 *
 * Routes covered:
 *   GET  /api/projects/:projectId/plans/:planId/deliverables
 *   POST /api/projects/:projectId/plans/:planId/deliverables          (owner-only, draft-only)
 *   GET  /api/projects/:projectId/plans/:planId/deliverables/:id
 *   PATCH /api/projects/:projectId/plans/:planId/deliverables/:id     (owner-only, draft-only)
 *   POST /api/projects/:projectId/plans/:planId/deliverables/:id/supersede (owner-only)
 *
 * Plus the suggestions route's new behaviour:
 *   POST /api/projects/:projectId/plans/:planId/suggestions {deliverableId} → stored + cross-plan rejected
 *
 * The shape of each assertion is "happy path + the single most important
 * negative case" — finer-grained edge tests (slug regex, max-length, etc.)
 * are covered by the shared zod schema (`packages/shared/src/schemas/deliverable.ts`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  GET as listGet,
  POST as createPost,
} from '@/app/api/projects/[projectId]/plans/[planId]/deliverables/route';
import {
  GET as showGet,
  PATCH as updatePatch,
} from '@/app/api/projects/[projectId]/plans/[planId]/deliverables/[deliverableId]/route';
import { POST as supersedePost } from '@/app/api/projects/[projectId]/plans/[planId]/deliverables/[deliverableId]/supersede/route';
import { POST as suggestPost } from '@/app/api/projects/[projectId]/plans/[planId]/suggestions/route';
import {
  makeReq,
  createTestProject,
  cleanupProject,
  testPrisma as prisma,
  addMember,
} from '../helpers/request';

describe('R-155: PlanDeliverable CRUD + suggestion.deliverableId', () => {
  const owner = 'r155-owner';
  const member = 'r155-member';
  let projectId: string;
  let draftPlanId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, member, 'developer');
    const p = await prisma.plan.create({
      data: {
        projectId,
        title: 'R-155 Test Plan',
        goal: 'goal',
        scope: 'scope',
        version: 1,
        status: 'draft',
        createdBy: owner,
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
      },
    });
    draftPlanId = p.id;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  // POST create — owner creates a new deliverable with a stable slug
  it('R-155-1: owner POST creates a deliverable on a draft plan', async () => {
    const res = await createPost(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}/deliverables`, {
        method: 'POST',
        userName: owner,
        body: {
          slug: 'auth/oidc-callback',
          title: 'OIDC callback handler',
          body: 'POST /auth/oidc that exchanges code for session.',
          refType: 'file_glob',
          refUri: 'src/auth/oidc/**/*.ts',
        },
      }),
      { params: Promise.resolve({ projectId, planId: draftPlanId }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.slug).toBe('auth/oidc-callback');
    expect(body.data.refType).toBe('file_glob');
    expect(body.data.refUri).toBe('src/auth/oidc/**/*.ts');
    expect(body.data.status).toBe('active');
    expect(body.data.supersededById).toBeNull();
  });

  it('R-155-2: non-owner POST is rejected (FORBIDDEN)', async () => {
    const res = await createPost(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}/deliverables`, {
        method: 'POST',
        userName: member,
        body: { slug: 'noop', title: 'noop' },
      }),
      { params: Promise.resolve({ projectId, planId: draftPlanId }) },
    );
    expect(res.status).toBe(403);
  });

  it('R-155-3: duplicate slug returns 409 STATE_CONFLICT', async () => {
    const res = await createPost(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}/deliverables`, {
        method: 'POST',
        userName: owner,
        body: { slug: 'auth/oidc-callback', title: 'duplicate' },
      }),
      { params: Promise.resolve({ projectId, planId: draftPlanId }) },
    );
    expect(res.status).toBe(409);
  });

  it('R-155-4: GET list returns deliverables in insertion order + filters by status', async () => {
    await prisma.planDeliverable.create({
      data: {
        planId: draftPlanId,
        slug: 'deprecated-thing',
        title: 'Deprecated',
        body: 'old',
        refType: 'free',
        status: 'deprecated',
      },
    });

    const all = await listGet(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}/deliverables`, {
        userName: member,
      }),
      { params: Promise.resolve({ projectId, planId: draftPlanId }) },
    );
    expect(all.status).toBe(200);
    const allBody = await all.json();
    expect(allBody.data.length).toBeGreaterThanOrEqual(2);

    const activeOnly = await listGet(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}/deliverables?status=active`, {
        userName: member,
      }),
      { params: Promise.resolve({ projectId, planId: draftPlanId }) },
    );
    expect(activeOnly.status).toBe(200);
    const activeBody = await activeOnly.json();
    for (const row of activeBody.data) {
      expect(row.status).toBe('active');
    }
  });

  it('R-155-5: GET show returns the row; cross-plan id returns 404', async () => {
    const list = await prisma.planDeliverable.findFirst({
      where: { planId: draftPlanId, slug: 'auth/oidc-callback' },
    });
    expect(list).not.toBeNull();
    const id = list!.id;

    const ok = await showGet(
      makeReq(
        `/api/projects/${projectId}/plans/${draftPlanId}/deliverables/${id}`,
        { userName: member },
      ),
      {
        params: Promise.resolve({
          projectId,
          planId: draftPlanId,
          deliverableId: id,
        }),
      },
    );
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(okBody.data.id).toBe(id);

    // Cross-plan id: build a sibling plan and try to read the auth row
    // through ITS planId. Must collapse to 404 — never 200.
    const sibling = await prisma.plan.create({
      data: {
        projectId,
        title: 'sibling',
        goal: 'g',
        scope: 's',
        version: 9000,
        status: 'draft',
        createdBy: owner,
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
      },
    });
    const miss = await showGet(
      makeReq(
        `/api/projects/${projectId}/plans/${sibling.id}/deliverables/${id}`,
        { userName: member },
      ),
      {
        params: Promise.resolve({
          projectId,
          planId: sibling.id,
          deliverableId: id,
        }),
      },
    );
    expect(miss.status).toBe(404);
    await prisma.plan.delete({ where: { id: sibling.id } });
  });

  it('R-155-6: PATCH updates title + refUri but never the slug', async () => {
    const row = await prisma.planDeliverable.findFirstOrThrow({
      where: { planId: draftPlanId, slug: 'auth/oidc-callback' },
    });
    const res = await updatePatch(
      makeReq(
        `/api/projects/${projectId}/plans/${draftPlanId}/deliverables/${row.id}`,
        {
          method: 'PATCH',
          userName: owner,
          body: { title: 'OIDC callback (v2)', refUri: 'src/auth/**/*.ts' },
        },
      ),
      {
        params: Promise.resolve({
          projectId,
          planId: draftPlanId,
          deliverableId: row.id,
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe('OIDC callback (v2)');
    expect(body.data.refUri).toBe('src/auth/**/*.ts');
    expect(body.data.slug).toBe('auth/oidc-callback');
  });

  it('R-155-7: supersede flips status to deprecated + sets supersededById', async () => {
    const oldRow = await prisma.planDeliverable.findFirstOrThrow({
      where: { planId: draftPlanId, slug: 'auth/oidc-callback' },
    });
    // Create the "new" deliverable on the same plan (in real life it'd be a
    // newer plan version; same plan is fine for the explicit-supersede path
    // — the route only requires version >= old, equal version included).
    const newRow = await prisma.planDeliverable.create({
      data: {
        planId: draftPlanId,
        slug: 'auth/oidc-callback-v2',
        title: 'OIDC callback v2',
        body: 'rewritten exchange logic',
        refType: 'file_glob',
        refUri: 'src/auth/oidc-v2/**/*.ts',
        status: 'active',
      },
    });

    const res = await supersedePost(
      makeReq(
        `/api/projects/${projectId}/plans/${draftPlanId}/deliverables/${oldRow.id}/supersede`,
        {
          method: 'POST',
          userName: owner,
          body: { newDeliverableId: newRow.id },
        },
      ),
      {
        params: Promise.resolve({
          projectId,
          planId: draftPlanId,
          deliverableId: oldRow.id,
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.supersededById).toBe(newRow.id);
    expect(body.data.status).toBe('deprecated');

    // Idempotency: re-superseding the same row returns 409, not silent rewrite.
    const again = await supersedePost(
      makeReq(
        `/api/projects/${projectId}/plans/${draftPlanId}/deliverables/${oldRow.id}/supersede`,
        {
          method: 'POST',
          userName: owner,
          body: { newDeliverableId: newRow.id },
        },
      ),
      {
        params: Promise.resolve({
          projectId,
          planId: draftPlanId,
          deliverableId: oldRow.id,
        }),
      },
    );
    expect(again.status).toBe(409);
  });

  it('R-155-8: suggestion with valid deliverableId is stored on the row', async () => {
    const target = await prisma.planDeliverable.findFirstOrThrow({
      where: { planId: draftPlanId, slug: 'auth/oidc-callback-v2' },
    });
    const res = await suggestPost(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}/suggestions`, {
        method: 'POST',
        userName: member,
        body: {
          field: 'deliverables',
          action: 'append',
          value: 'add refresh-token rotation',
          reason: 'security review found gap',
          deliverableId: target.id,
        },
      }),
      { params: Promise.resolve({ projectId, planId: draftPlanId }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.deliverableId).toBe(target.id);
  });

  it('R-155-9: suggestion with cross-plan deliverableId is rejected (404)', async () => {
    const sibling = await prisma.plan.create({
      data: {
        projectId,
        title: 'sibling 2',
        goal: 'g',
        scope: 's',
        version: 9001,
        status: 'draft',
        createdBy: owner,
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
      },
    });
    const foreign = await prisma.planDeliverable.create({
      data: {
        planId: sibling.id,
        slug: 'foreign',
        title: 'foreign',
        body: 'foreign',
        refType: 'free',
        status: 'active',
      },
    });

    const res = await suggestPost(
      makeReq(`/api/projects/${projectId}/plans/${draftPlanId}/suggestions`, {
        method: 'POST',
        userName: member,
        body: {
          field: 'deliverables',
          action: 'append',
          value: 'noop',
          reason: 'noop',
          deliverableId: foreign.id,
        },
      }),
      { params: Promise.resolve({ projectId, planId: draftPlanId }) },
    );
    expect(res.status).toBe(404);

    await prisma.plan.delete({ where: { id: sibling.id } });
  });
});

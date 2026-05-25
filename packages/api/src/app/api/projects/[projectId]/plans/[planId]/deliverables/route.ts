/**
 * R-155: REST surface for the `PlanDeliverable` table.
 *
 * Routes
 *   GET  /api/projects/:projectId/plans/:planId/deliverables
 *        — any project member: list deliverables on a plan (filterable by
 *          `status` and `refType` so the GitHub Action drift-gate from
 *          R-157 can scope its `file_glob` lookup in one call).
 *   POST /api/projects/:projectId/plans/:planId/deliverables
 *        — owner only, draft plans only: create a new deliverable row.
 *
 * The single-deliverable read/update + supersede live in the sibling
 * `[deliverableId]/route.ts` and `[deliverableId]/supersede/route.ts`
 * files.
 *
 * Owner-only writes: enforced by `requireProjectRole(..., 'owner')` plus
 * `requireNotExecScoped` so an exec-scoped API key from a running task
 * cannot mutate plan structure mid-flight (same posture as plan create /
 * update routes). Draft-only edits: enforced by checking `plan.status`
 * against the same allow-list `append` / `update` use — proposed and
 * active plans are immutable so review and drift v2 stay deterministic.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody, validateSearchParams } from '@/lib/validate';
import {
  AppError,
  ErrorCode,
  createDeliverableSchema,
  deliverableRefTypeSchema,
  deliverableStatusSchema,
} from '@plansync/shared';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { createActivity } from '@/lib/activity';
import { requirePlanInProject } from '@/lib/plan-scope';

type Params = { params: Promise<{ projectId: string; planId: string }> };

const listQuerySchema = z.object({
  status: deliverableStatusSchema.optional(),
  refType: deliverableRefTypeSchema.optional(),
});

export async function GET(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    await requirePlanInProject(params.planId, params.projectId);
    const query = validateSearchParams(req, listQuerySchema);

    const where: { planId: string; status?: string; refType?: string } = {
      planId: params.planId,
    };
    if (query.status) where.status = query.status;
    if (query.refType) where.refType = query.refType;

    const rows = await prisma.planDeliverable.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    return NextResponse.json({ data: rows });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, createDeliverableSchema);

    const plan = await requirePlanInProject(params.planId, params.projectId);
    if (plan.status !== 'draft') {
      // Editing deliverables on a `proposed` or `active` plan would silently
      // invalidate ongoing reviews and break drift v2 attribution. The
      // supported path is to draft a new plan version and supersede the
      // current row via the supersede endpoint instead.
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Only draft plans can have deliverables added');
    }

    let created;
    try {
      created = await prisma.planDeliverable.create({
        data: {
          planId: params.planId,
          slug: body.slug,
          title: body.title,
          body: body.body ?? body.title,
          refType: body.refType ?? 'free',
          refUri: body.refUri ?? null,
          status: body.status ?? 'active',
        },
      });
    } catch (err) {
      // Prisma P2002 on the (plan_id, slug) unique key → 409 STATE_CONFLICT
      // with a stable message so callers can detect the duplicate. We do not
      // attempt to leak the underlying constraint name in the message; the
      // code-level discriminator is enough.
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        throw new AppError(
          ErrorCode.STATE_CONFLICT,
          `Deliverable with slug "${body.slug}" already exists on this plan`,
        );
      }
      throw err;
    }

    await createActivity({
      projectId: params.projectId,
      type: 'plan_draft_updated',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Added deliverable "${body.slug}" to Plan v${plan.version}`,
      metadata: {
        planId: params.planId,
        deliverableId: created.id,
        slug: created.slug,
      },
    });

    eventBus.publish(params.projectId, 'plan_draft_updated', {
      planId: params.planId,
      version: plan.version,
      updatedBy: auth.userName,
      fields: ['deliverables'],
    });
    dispatchWebhooks(params.projectId, 'plan_draft_updated', {
      planId: params.planId,
      version: plan.version,
      updatedBy: auth.userName,
      fields: ['deliverables'],
    });

    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

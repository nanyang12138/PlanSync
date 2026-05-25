/**
 * R-155: explicit per-row supersede.
 *
 *   POST /api/projects/:projectId/plans/:planId/deliverables/:deliverableId/supersede
 *
 * Owner only. Links one deliverable row (the "old" row, identified by the
 * URL `deliverableId`) to another deliverable row (the "new" row, supplied
 * as `newDeliverableId` in the body) by setting the old row's
 * `supersededById` to the new row's id and flipping the old row's
 * `status` to `deprecated`.
 *
 * This is the manual companion to `supersedeDeliverables()` in
 * `lib/plan-items.ts`, which is the automatic supersede wired into the
 * activate path. The two are interchangeable in effect — both end with
 * the older row pointing to the newer one — but the manual endpoint exists
 * because:
 *   1. an owner may want to retire a deliverable mid-plan-version without
 *      activating a new plan (e.g. "this feature was cancelled");
 *   2. the automatic activate-time supersede only matches by `slug`; if
 *      the owner intentionally renames a deliverable across versions
 *      (slug change) the new row will not auto-link and the owner has to
 *      call this endpoint to draw the chain manually.
 *
 * Invariants enforced:
 *   - `newDeliverableId` exists.
 *   - Both rows are scoped to the same project (cross-project chains are
 *     forbidden so chain traversal can never leak data across tenants).
 *   - The new row must be on the same plan OR on a plan that is currently
 *     `active` for the project. Older plans cannot supersede newer ones —
 *     the direction is always "new replaces old". This is enforced by
 *     requiring the new row's plan version to be >= the old row's plan
 *     version.
 *   - The old row must not already be superseded (idempotent: re-pointing
 *     would silently rewrite history; the route returns 409 with the
 *     existing pointer so the caller can choose to undo first).
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { AppError, ErrorCode, supersedeDeliverableSchema } from '@plansync/shared';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { createActivity } from '@/lib/activity';
import { requirePlanInProject } from '@/lib/plan-scope';

type Params = {
  params: Promise<{ projectId: string; planId: string; deliverableId: string }>;
};

export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, supersedeDeliverableSchema);

    const oldPlan = await requirePlanInProject(params.planId, params.projectId);

    const oldRow = await prisma.planDeliverable.findUnique({
      where: { id: params.deliverableId },
    });
    if (!oldRow || oldRow.planId !== params.planId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Deliverable not found');
    }

    if (oldRow.supersededById) {
      throw new AppError(
        ErrorCode.STATE_CONFLICT,
        `Deliverable is already superseded by "${oldRow.supersededById}"`,
      );
    }

    if (body.newDeliverableId === oldRow.id) {
      throw new AppError(ErrorCode.BAD_REQUEST, 'A deliverable cannot supersede itself');
    }

    // Fetch the new row + its enclosing plan so we can enforce the
    // project + version-ordering invariants in one round trip.
    const newRow = await prisma.planDeliverable.findUnique({
      where: { id: body.newDeliverableId },
      include: { plan: { select: { projectId: true, version: true } } },
    });
    if (!newRow) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Target deliverable not found');
    }
    if (newRow.plan.projectId !== params.projectId) {
      // Hide cross-project existence: same NOT_FOUND surface as a real miss.
      throw new AppError(ErrorCode.NOT_FOUND, 'Target deliverable not found');
    }
    if (newRow.plan.version < oldPlan.version) {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        'Target deliverable must be on the same or a newer plan version',
      );
    }

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.planDeliverable.update({
        where: { id: params.deliverableId },
        data: {
          supersededById: body.newDeliverableId,
          status: 'deprecated',
        },
      });
      return row;
    });

    await createActivity({
      projectId: params.projectId,
      type: 'plan_draft_updated',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Superseded deliverable "${oldRow.slug}" with "${newRow.slug}"`,
      metadata: {
        planId: params.planId,
        oldDeliverableId: oldRow.id,
        newDeliverableId: newRow.id,
        oldSlug: oldRow.slug,
        newSlug: newRow.slug,
      },
    });

    eventBus.publish(params.projectId, 'plan_draft_updated', {
      planId: params.planId,
      version: oldPlan.version,
      updatedBy: auth.userName,
      fields: ['deliverables'],
    });
    dispatchWebhooks(params.projectId, 'plan_draft_updated', {
      planId: params.planId,
      version: oldPlan.version,
      updatedBy: auth.userName,
      fields: ['deliverables'],
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

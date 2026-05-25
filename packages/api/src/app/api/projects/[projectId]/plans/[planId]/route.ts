import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { updatePlanSchema, AppError, ErrorCode } from '@plansync/shared';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { requirePlanInProject } from '@/lib/plan-scope';
import { createActivity } from '@/lib/activity';
import { writeBoth } from '@/lib/plan-items';

type Params = { params: Promise<{ projectId: string; planId: string }> };

export async function GET(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    const plan = await requirePlanInProject<{
      reviews: Array<{ id: string; reviewerName: string; status: string }>;
    }>(params.planId, params.projectId, { include: { reviews: true } });

    return NextResponse.json({ data: plan });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, updatePlanSchema);

    const plan = await requirePlanInProject(params.planId, params.projectId);
    if (plan.status !== 'draft') {
      // Proposed plans: only requiredReviewers can be updated (adding reviewers mid-review is safe)
      const bodyKeys = Object.keys(body);
      if (
        plan.status === 'proposed' &&
        bodyKeys.length > 0 &&
        bodyKeys.every((k) => k === 'requiredReviewers')
      ) {
        // allowed — fall through to update
      } else {
        throw new AppError(ErrorCode.STATE_CONFLICT, 'Only draft plans can be edited');
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      // R-152: split off the array fields that have a sibling table so we
      // can route them through writeBoth (legacy String[] + split rows
      // updated atomically). The remaining scalar / openQuestions fields
      // still go through plan.update directly. Both happen inside the same
      // transaction, so a failure on either side rolls the whole patch back.
      const { deliverables, constraints, standards, ...rest } = body;
      await tx.plan.update({
        where: { id: params.planId },
        data: rest,
      });
      if (deliverables !== undefined || constraints !== undefined || standards !== undefined) {
        await writeBoth(params.planId, { deliverables, constraints, standards }, tx);
      }
      // Re-read so the response reflects whatever writeBoth wrote to the
      // legacy columns (and the bumped `updatedAt`). Both updates are inside
      // this transaction, so the returned snapshot is internally consistent.
      const p = await tx.plan.findUniqueOrThrow({ where: { id: params.planId } });

      // For proposed plans: create review records for newly added reviewers
      if (plan.status === 'proposed' && body.requiredReviewers) {
        const existing = await tx.planReview.findMany({
          where: { planId: params.planId },
          select: { reviewerName: true },
        });
        const existingNames = new Set(existing.map((r) => r.reviewerName));
        const newReviewers = body.requiredReviewers.filter((r) => !existingNames.has(r));
        if (newReviewers.length > 0) {
          await tx.planReview.createMany({
            data: newReviewers.map((reviewerName) => ({
              planId: params.planId,
              reviewerName,
              status: 'pending',
            })),
          });
        }
      }

      return p;
    });

    eventBus.publish(params.projectId, 'plan_draft_updated', {
      planId: updated.id,
      version: updated.version,
      updatedBy: auth.userName,
      fields: Object.keys(body),
    });
    dispatchWebhooks(params.projectId, 'plan_draft_updated', {
      planId: updated.id,
      version: updated.version,
      updatedBy: auth.userName,
      fields: Object.keys(body),
    });

    // R-104: audit trail for owner-driven plan edits. We always emit
    // `plan_updated` here (the existing `plan_draft_updated` event name is
    // kept for compatibility with the SSE/webhook surface). Surfacing the
    // changed fields in the metadata lets the activity log explain *what*
    // changed without having to diff plan revisions after the fact.
    const fields = Object.keys(body);
    await createActivity({
      projectId: params.projectId,
      type: 'plan_updated',
      actorName: auth.userName,
      actorType: 'human',
      summary:
        fields.length > 0
          ? `Plan v${updated.version} "${updated.title}" updated (${fields.join(', ')})`
          : `Plan v${updated.version} "${updated.title}" updated`,
      metadata: {
        planId: updated.id,
        version: updated.version,
        fields,
        planStatus: plan.status,
      },
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');

    const plan = await requirePlanInProject(params.planId, params.projectId);
    if (plan.status !== 'draft') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Only draft plans can be deleted');
    }

    await prisma.plan.delete({ where: { id: params.planId } });
    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    return handleApiError(error);
  }
}

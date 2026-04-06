import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { updatePlanSchema, AppError, ErrorCode } from '@plansync/shared';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';

type Params = { params: { projectId: string; planId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    const plan = await prisma.plan.findUnique({
      where: { id: params.planId },
      include: { reviews: true },
    });
    if (!plan) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    if (plan.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    }

    return NextResponse.json({ data: plan });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, updatePlanSchema);

    const plan = await prisma.plan.findUnique({ where: { id: params.planId } });
    if (!plan) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    if (plan.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    }
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
      const p = await tx.plan.update({
        where: { id: params.planId },
        data: body,
      });

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
      updatedBy: auth.userName,
      fields: Object.keys(body),
    });
    dispatchWebhooks(params.projectId, 'plan_draft_updated', {
      planId: updated.id,
      updatedBy: auth.userName,
      fields: Object.keys(body),
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');

    const plan = await prisma.plan.findUnique({ where: { id: params.planId } });
    if (!plan) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    if (plan.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    }
    if (plan.status !== 'draft') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Only draft plans can be deleted');
    }

    await prisma.plan.delete({ where: { id: params.planId } });
    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    return handleApiError(error);
  }
}

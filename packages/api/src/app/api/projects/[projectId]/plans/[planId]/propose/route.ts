import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';

type Params = { params: { projectId: string; planId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');

    let body: { reviewers?: string[] } = {};
    try {
      body = await req.json();
    } catch {
      /* empty body OK if requiredReviewers on plan */
    }

    const plan = await prisma.plan.findUnique({ where: { id: params.planId } });
    if (!plan) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    if (plan.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    }
    if (plan.status !== 'draft') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Only draft plans can be proposed');
    }

    const reviewers =
      body.reviewers && body.reviewers.length > 0 ? body.reviewers : plan.requiredReviewers;

    const updated = await prisma.$transaction(async (tx) => {
      const p = await tx.plan.update({
        where: { id: params.planId },
        data: { status: 'proposed', requiredReviewers: reviewers },
      });

      if (reviewers.length > 0) {
        await tx.planReview.createMany({
          data: reviewers.map((reviewer: string) => ({
            planId: plan.id,
            reviewerName: reviewer,
            status: 'pending',
          })),
        });
      }

      return p;
    });

    await createActivity({
      projectId: params.projectId,
      type: 'plan_proposed',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Plan v${plan.version} proposed for review`,
      metadata: { planId: plan.id, version: plan.version },
    });

    eventBus.publish(params.projectId, 'plan_proposed', {
      planId: plan.id,
      version: plan.version,
      title: plan.title,
      proposedBy: auth.userName,
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

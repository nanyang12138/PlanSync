import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';

type Params = { params: { projectId: string; planId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');

    const plan = await prisma.plan.findUnique({ where: { id: params.planId } });
    if (!plan) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    if (plan.status !== 'draft') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Only draft plans can be proposed');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const p = await tx.plan.update({
        where: { id: params.planId },
        data: { status: 'proposed' },
      });

      if (plan.requiredReviewers.length > 0) {
        await tx.planReview.createMany({
          data: plan.requiredReviewers.map((reviewer) => ({
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

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

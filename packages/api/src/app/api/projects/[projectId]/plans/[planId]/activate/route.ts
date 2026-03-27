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

    const plan = await prisma.plan.findUnique({
      where: { id: params.planId },
      include: { reviews: true },
    });
    if (!plan) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');

    if (plan.status !== 'draft' && plan.status !== 'proposed') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Plan must be draft or proposed to activate');
    }

    if (plan.status === 'proposed' && plan.reviews.length > 0) {
      const allApproved = plan.reviews.every((r) => r.status === 'approved');
      if (!allApproved) {
        throw new AppError(ErrorCode.STATE_CONFLICT, 'Not all reviewers have approved');
      }
    }

    const activated = await prisma.$transaction(async (tx) => {
      await tx.plan.updateMany({
        where: { projectId: params.projectId, status: 'active' },
        data: { status: 'superseded' },
      });

      return tx.plan.update({
        where: { id: params.planId },
        data: {
          status: 'active',
          activatedAt: new Date(),
          activatedBy: auth.userName,
        },
      });
    });

    await createActivity({
      projectId: params.projectId,
      type: 'plan_activated',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Plan v${activated.version} "${activated.title}" activated`,
      metadata: { planId: activated.id, version: activated.version },
    });

    return NextResponse.json({ data: activated });
  } catch (error) {
    return handleApiError(error);
  }
}

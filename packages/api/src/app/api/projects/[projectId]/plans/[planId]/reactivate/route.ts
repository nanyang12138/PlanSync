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
    if (plan.status !== 'superseded') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Only superseded plans can be reactivated');
    }

    const reactivated = await prisma.$transaction(async (tx) => {
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
      type: 'plan_reactivated',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Plan v${reactivated.version} reactivated (rollback)`,
      metadata: { planId: reactivated.id, version: reactivated.version },
    });

    return NextResponse.json({ data: reactivated });
  } catch (error) {
    return handleApiError(error);
  }
}

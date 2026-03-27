import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { resolveDriftSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';

type Params = { params: { projectId: string; driftId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, resolveDriftSchema);

    const drift = await prisma.driftAlert.findUnique({
      where: { id: params.driftId },
      include: { task: true },
    });
    if (!drift) throw new AppError(ErrorCode.NOT_FOUND, 'Drift alert not found');
    if (drift.status !== 'open') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Drift alert already resolved');
    }

    const activePlan = await prisma.plan.findFirst({
      where: { projectId: params.projectId, status: 'active' },
    });

    await prisma.$transaction(async (tx) => {
      await tx.driftAlert.update({
        where: { id: params.driftId },
        data: {
          status: 'resolved',
          resolvedAction: body.action,
          resolvedAt: new Date(),
          resolvedBy: auth.userName,
        },
      });

      if (body.action === 'rebind' && activePlan) {
        await tx.task.update({
          where: { id: drift.taskId },
          data: { boundPlanVersion: activePlan.version },
        });
      } else if (body.action === 'cancel') {
        await tx.task.update({
          where: { id: drift.taskId },
          data: { status: 'cancelled' },
        });
        await tx.executionRun.updateMany({
          where: { taskId: drift.taskId, status: 'running' },
          data: { status: 'cancelled', endedAt: new Date() },
        });
      }
    });

    await createActivity({
      projectId: params.projectId,
      type: 'drift_resolved',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Drift alert resolved: ${body.action} for "${drift.task.title}"`,
      metadata: { driftId: drift.id, action: body.action, taskId: drift.taskId },
    });

    return NextResponse.json({ data: { resolved: true, action: body.action } });
  } catch (error) {
    return handleApiError(error);
  }
}

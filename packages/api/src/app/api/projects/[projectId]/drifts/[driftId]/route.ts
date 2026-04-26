import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { resolveDriftSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';

type Params = { params: { projectId: string; driftId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    const member = await requireProjectRole(auth, params.projectId);
    const body = await validateBody(req, resolveDriftSchema);

    const drift = await prisma.driftAlert.findUnique({
      where: { id: params.driftId },
      include: { task: true },
    });
    if (!drift) throw new AppError(ErrorCode.NOT_FOUND, 'Drift alert not found');
    if (drift.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Drift alert not found');
    }

    const isOwner = member.projectRole === 'owner';
    const isAssignee = drift.task.assignee === auth.userName;
    if (!isOwner && !isAssignee) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Only project owners or the task assignee can resolve this drift alert',
      );
    }

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

      if (body.action === 'rebind' && !activePlan) {
        throw new AppError(ErrorCode.STATE_CONFLICT, 'No active plan to rebind to');
      }
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

    eventBus.publish(params.projectId, 'drift_resolved', {
      alertId: drift.id,
      action: body.action,
      resolvedBy: auth.userName,
    });
    dispatchWebhooks(params.projectId, 'drift_resolved', {
      alertId: drift.id,
      action: body.action,
      resolvedBy: auth.userName,
    });

    return NextResponse.json({ data: { resolved: true, action: body.action } });
  } catch (error) {
    return handleApiError(error);
  }
}

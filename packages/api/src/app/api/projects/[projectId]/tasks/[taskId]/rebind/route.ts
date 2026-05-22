import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';

type Params = { params: { projectId: string; taskId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    // R-135: scope by projectId so rebind cannot be invoked against a task in another project.
    const task = await prisma.task.findFirst({
      where: { id: params.taskId, projectId: params.projectId },
    });
    if (!task) throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');

    const activePlan = await prisma.plan.findFirst({
      where: { projectId: params.projectId, status: 'active' },
    });
    if (!activePlan) {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'No active plan to rebind to');
    }

    if (task.boundPlanVersion === activePlan.version) {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Task already bound to current active plan');
    }

    const oldVersion = task.boundPlanVersion;
    const updated = await prisma.$transaction(async (tx) => {
      const t = await tx.task.update({
        where: { id: params.taskId },
        data: { boundPlanVersion: activePlan.version },
      });
      await tx.driftAlert.updateMany({
        where: { taskId: params.taskId, projectId: params.projectId, status: 'open' },
        data: {
          status: 'resolved',
          resolvedAction: 'rebind',
          resolvedAt: new Date(),
          resolvedBy: auth.userName,
        },
      });
      return t;
    });

    await createActivity({
      projectId: params.projectId,
      type: 'task_rebound',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Task "${task.title}" rebound from plan v${oldVersion} to v${activePlan.version}`,
      metadata: { taskId: task.id, oldVersion, newVersion: activePlan.version },
    });

    eventBus.publish(params.projectId, 'drift_resolved', {
      taskId: params.taskId,
      title: task.title,
      resolvedBy: auth.userName,
      oldVersion,
      newVersion: activePlan.version,
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

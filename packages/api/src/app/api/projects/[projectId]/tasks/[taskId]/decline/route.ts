import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';

type Params = { params: { projectId: string; taskId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    const task = await prisma.task.findUnique({ where: { id: params.taskId } });
    if (!task) throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    if (task.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }

    if (task.assignee !== auth.userName) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Only the current assignee can decline a task');
    }

    if (task.status !== 'todo') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Only tasks in todo status can be declined');
    }

    const updated = await prisma.task.update({
      where: { id: params.taskId },
      data: {
        assignee: null,
        assigneeType: 'unassigned',
      },
    });

    await createActivity({
      projectId: params.projectId,
      type: 'task_declined',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Task "${task.title}" declined by ${auth.userName}`,
      metadata: { taskId: task.id },
    });

    eventBus.publish(params.projectId, 'task_unassigned', {
      taskId: task.id,
      previousAssignee: task.assignee,
    });
    dispatchWebhooks(params.projectId, 'task_unassigned', {
      taskId: task.id,
      title: task.title,
      previousAssignee: task.assignee,
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { claimTaskSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';

type Params = { params: { projectId: string; taskId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const body = await validateBody(req, claimTaskSchema);

    const task = await prisma.task.findUnique({ where: { id: params.taskId } });
    if (!task) throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    if (task.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }
    if (task.status !== 'todo') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Only todo tasks can be claimed');
    }

    const updated = await prisma.task.update({
      where: { id: params.taskId },
      data: {
        assignee: auth.userName,
        assigneeType: body.assigneeType,
        status: 'in_progress',
      },
    });

    await createActivity({
      projectId: params.projectId,
      type: 'task_claimed',
      actorName: auth.userName,
      actorType: body.assigneeType === 'agent' ? 'agent' : 'human',
      summary: `Task "${task.title}" claimed by ${auth.userName}`,
      metadata: { taskId: task.id },
    });

    eventBus.publish(params.projectId, 'task_assigned', {
      taskId: task.id,
      assignee: auth.userName,
    });
    dispatchWebhooks(params.projectId, 'task_assigned', {
      taskId: task.id,
      assignee: auth.userName,
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

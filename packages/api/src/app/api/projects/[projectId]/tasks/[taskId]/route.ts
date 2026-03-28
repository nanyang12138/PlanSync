import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { updateTaskSchema, AppError, ErrorCode } from '@plansync/shared';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';

type Params = { params: { projectId: string; taskId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    const task = await prisma.task.findUnique({
      where: { id: params.taskId },
      include: { executionRuns: { orderBy: { startedAt: 'desc' }, take: 5 } },
    });
    if (!task) throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    if (task.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }

    return NextResponse.json({ data: task });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const body = await validateBody(req, updateTaskSchema);

    const task = await prisma.task.findUnique({ where: { id: params.taskId } });
    if (!task) throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    if (task.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }

    const updated = await prisma.task.update({
      where: { id: params.taskId },
      data: body,
    });

    if (body.assignee && body.assignee !== task.assignee) {
      eventBus.publish(params.projectId, 'task_assigned', {
        taskId: params.taskId,
        assignee: body.assignee,
      });
      dispatchWebhooks(params.projectId, 'task_assigned', {
        taskId: params.taskId,
        title: updated.title,
        assignee: body.assignee,
      });
    }

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');

    const task = await prisma.task.findUnique({ where: { id: params.taskId } });
    if (!task) throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    if (task.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }

    await prisma.task.delete({ where: { id: params.taskId } });
    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    return handleApiError(error);
  }
}

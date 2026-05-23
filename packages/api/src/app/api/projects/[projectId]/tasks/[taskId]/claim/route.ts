import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { claimTaskSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { auditCrossProjectTaskIfNeeded } from '@/lib/task-scope';

type Params = { params: { projectId: string; taskId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const body = await validateBody(req, claimTaskSchema);

    // R-135: scope by projectId so a member of project A cannot claim a task
    // that lives in project B by guessing the taskId.
    const task = await prisma.task.findFirst({
      where: { id: params.taskId, projectId: params.projectId },
    });
    if (!task) {
      await auditCrossProjectTaskIfNeeded(params.taskId, params.projectId, 'POST /tasks/:id/claim');
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }
    if (task.status !== 'todo') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Only todo tasks can be claimed');
    }
    if (task.assignee) {
      throw new AppError(ErrorCode.CONFLICT, 'Task is already assigned', {
        code: 'TASK_ALREADY_CLAIMED',
        currentAssignee: task.assignee,
      });
    }

    const claimResult = await prisma.task.updateMany({
      where: {
        id: params.taskId,
        projectId: params.projectId,
        assignee: null,
        status: 'todo',
      },
      data: {
        assignee: auth.userName,
        assigneeType: body.assigneeType,
        ...(body.startImmediately ? { status: 'in_progress' } : {}),
      },
    });

    if (claimResult.count === 0) {
      throw new AppError(ErrorCode.CONFLICT, 'Task is already assigned', {
        code: 'TASK_ALREADY_CLAIMED',
      });
    }

    // R-135: scope re-read by projectId for consistency with the initial fetch.
    const updated = await prisma.task.findFirst({
      where: { id: params.taskId, projectId: params.projectId },
    });
    if (!updated) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }

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

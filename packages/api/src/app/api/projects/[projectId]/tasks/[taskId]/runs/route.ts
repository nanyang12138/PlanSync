import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody, validateSearchParams } from '@/lib/validate';
import { createExecutionRunSchema, paginationSchema, AppError, ErrorCode } from '@plansync/shared';
import { buildTaskPack } from '@/lib/task-pack';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';

type Params = { params: { projectId: string; taskId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const { page = 1, pageSize = 20 } = validateSearchParams(req, paginationSchema);
    const skip = (page - 1) * pageSize;

    const task = await prisma.task.findFirst({
      where: { id: params.taskId, projectId: params.projectId },
    });
    if (!task) throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');

    const [runs, total] = await Promise.all([
      prisma.executionRun.findMany({
        where: { taskId: params.taskId },
        skip,
        take: pageSize,
        orderBy: { startedAt: 'desc' },
      }),
      prisma.executionRun.count({ where: { taskId: params.taskId } }),
    ]);

    return NextResponse.json({
      data: runs,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const body = await validateBody(req, createExecutionRunSchema);

    const task = await prisma.task.findUnique({ where: { id: params.taskId } });
    if (!task) throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    if (task.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }

    // Authorization: humans cannot impersonate other users; agents must be registered members
    if (body.executorType === 'human' && body.executorName !== auth.userName) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Cannot start execution as another user');
    }
    if (body.executorType === 'agent') {
      const agentMember = await prisma.projectMember.findFirst({
        where: { projectId: params.projectId, name: body.executorName, type: 'agent' },
      });
      if (!agentMember) {
        throw new AppError(
          ErrorCode.BAD_REQUEST,
          `Agent "${body.executorName}" is not a registered member of this project`,
        );
      }
    }

    const taskPack = await buildTaskPack(params.taskId, params.projectId);

    if (taskPack && taskPack.driftAlerts.length > 0) {
      return NextResponse.json(
        {
          error: {
            code: 'DRIFT_UNRESOLVED',
            message: `Task has ${taskPack.driftAlerts.length} unresolved drift alert(s). Resolve them before starting execution.`,
            details: { drifts: taskPack.driftAlerts },
          },
        },
        { status: 409 },
      );
    }

    const run = await prisma.executionRun.create({
      data: {
        taskId: params.taskId,
        executorType: body.executorType,
        executorName: body.executorName,
        boundPlanVersion: task.boundPlanVersion,
        status: 'running',
        taskPackSnapshot: taskPack as object,
        lastHeartbeatAt: new Date(),
        filesChanged: [],
        blockers: [],
        driftSignals: [],
      },
    });

    if (task.status === 'todo' || task.status === 'in_progress') {
      await prisma.task.update({
        where: { id: params.taskId },
        data: {
          status: 'in_progress',
          assignee: body.executorName,
          assigneeType: body.executorType,
        },
      });
    }

    await createActivity({
      projectId: params.projectId,
      type: 'execution_started',
      actorName: body.executorName,
      actorType: body.executorType,
      summary: `Execution started for "${task.title}"`,
      metadata: { runId: run.id, taskId: params.taskId },
    });

    eventBus.publish(params.projectId, 'task_started', {
      taskId: params.taskId,
      executorName: body.executorName,
      executorType: body.executorType,
    });
    dispatchWebhooks(params.projectId, 'task_started', {
      taskId: params.taskId,
      title: task.title,
      executorName: body.executorName,
      executorType: body.executorType,
    });

    return NextResponse.json({ data: run }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

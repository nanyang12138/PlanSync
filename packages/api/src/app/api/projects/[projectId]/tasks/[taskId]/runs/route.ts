import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody, validateSearchParams } from '@/lib/validate';
import { createExecutionRunSchema, paginationSchema, AppError, ErrorCode } from '@plansync/shared';
import { buildTaskPack } from '@/lib/task-pack';
import { createActivity } from '@/lib/activity';

type Params = { params: { projectId: string; taskId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const { page, pageSize } = validateSearchParams(req, paginationSchema);
    const skip = (page - 1) * pageSize;

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

    const taskPack = await buildTaskPack(params.taskId, params.projectId);

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
        data: { status: 'in_progress', assignee: body.executorName, assigneeType: body.executorType },
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

    return NextResponse.json({ data: run }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

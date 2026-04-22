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

    // Authorization: humans cannot impersonate other users; agents must match task.assignee.
    if (body.executorType === 'human' && body.executorName !== auth.userName) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Cannot start execution as another user');
    }
    if (body.executorType === 'agent') {
      // Identity check: prevent one agent from silently taking over another agent's task.
      // Cross-type claim (agent picking up a human-assigned or unassigned task) is allowed —
      // it falls through to the todo→in_progress claim path which sets assignee atomically.
      if (task.assigneeType === 'agent' && task.assignee && task.assignee !== body.executorName) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          `Task is assigned to agent "${task.assignee}" — cannot execute as "${body.executorName}". Use task_claim/task_decline to change assignee.`,
        );
      }
      // Auto-register agent as a project member on first execution — no manual setup required
      await prisma.projectMember.upsert({
        where: { projectId_name: { projectId: params.projectId, name: body.executorName } },
        create: {
          projectId: params.projectId,
          name: body.executorName,
          role: 'developer',
          type: 'agent',
        },
        update: {},
      });
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

    if (task.status === 'todo') {
      // Atomic claim: transition from 'todo' → 'in_progress' in a single DB operation.
      // If two operators race on the same todo task, only one wins — the other gets count=0.
      const claimed = await prisma.task.updateMany({
        where: { id: params.taskId, status: 'todo' },
        data: {
          status: 'in_progress',
          assignee: body.executorName,
          assigneeType: body.executorType,
        },
      });
      if (claimed.count === 0) {
        throw new AppError(
          ErrorCode.STATE_CONFLICT,
          `Task was just claimed by another executor — only one executor at a time`,
        );
      }
    } else if (task.status === 'in_progress') {
      // Mutex: only one running run per task. Stale/failed/completed runs allow retry.
      // task.assignee is preserved — set on the original todo→in_progress claim, not rewritten here.
      const activeRun = await prisma.executionRun.findFirst({
        where: { taskId: params.taskId, status: 'running' },
        select: { id: true, executorName: true, lastHeartbeatAt: true },
      });
      if (activeRun) {
        throw new AppError(
          ErrorCode.STATE_CONFLICT,
          `Task already has an active execution by "${activeRun.executorName}" (runId: ${activeRun.id}). Wait for it to complete, fail, or go stale (5min heartbeat timeout).`,
        );
      }
    }

    let run;
    try {
      run = await prisma.executionRun.create({
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
    } catch (err) {
      // P2002 = unique constraint violation from the partial index
      // (execution_runs_one_running_per_task). Race with another concurrent start.
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        throw new AppError(
          ErrorCode.STATE_CONFLICT,
          'Task already has an active execution — another executor just started one. Retry after it finishes or goes stale.',
        );
      }
      throw err;
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

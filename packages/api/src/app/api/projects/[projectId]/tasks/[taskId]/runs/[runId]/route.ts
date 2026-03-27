import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { completeExecutionRunSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';

type Params = { params: { projectId: string; taskId: string; runId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    const run = await prisma.executionRun.findUnique({ where: { id: params.runId } });
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, 'ExecutionRun not found');

    if (action === 'heartbeat') {
      if (run.status !== 'running') {
        throw new AppError(ErrorCode.STATE_CONFLICT, 'Can only heartbeat running executions');
      }
      const updated = await prisma.executionRun.update({
        where: { id: params.runId },
        data: { lastHeartbeatAt: new Date() },
      });
      return NextResponse.json({ data: updated });
    }

    if (action === 'complete') {
      if (run.status !== 'running') {
        throw new AppError(ErrorCode.STATE_CONFLICT, 'Can only complete running executions');
      }
      const body = await validateBody(req, completeExecutionRunSchema);
      const updated = await prisma.executionRun.update({
        where: { id: params.runId },
        data: {
          ...body,
          endedAt: new Date(),
        },
      });

      if (body.status === 'completed') {
        await prisma.task.update({
          where: { id: params.taskId },
          data: { status: 'done' },
        });
      }

      const activityType = body.status === 'completed' ? 'execution_completed' : 'execution_failed';
      await createActivity({
        projectId: params.projectId,
        type: activityType,
        actorName: run.executorName,
        actorType: run.executorType as 'human' | 'agent',
        summary: `Execution ${body.status} for task`,
        metadata: { runId: run.id, taskId: params.taskId },
      });

      return NextResponse.json({ data: updated });
    }

    throw new AppError(ErrorCode.BAD_REQUEST, 'Action must be "heartbeat" or "complete"');
  } catch (error) {
    return handleApiError(error);
  }
}

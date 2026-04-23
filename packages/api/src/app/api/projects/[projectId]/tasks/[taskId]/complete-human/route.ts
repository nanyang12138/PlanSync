import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { buildTaskPack } from '@/lib/task-pack';

const schema = z.object({
  completionNote: z.string().min(1).max(5000),
  prUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'PR URL must use http(s)')
    .optional()
    .or(z.literal('')),
});

type Params = { params: { projectId: string; taskId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    const body = schema.parse(await req.json());

    const task = await prisma.task.findUnique({ where: { id: params.taskId } });
    if (!task || task.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }
    if (task.assigneeType === 'agent') {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Agent tasks must be completed via execution_complete',
      );
    }
    if (!task.assignee) {
      throw new AppError(
        ErrorCode.STATE_CONFLICT,
        'Task must be claimed before it can be completed',
      );
    }
    if (task.status !== 'in_progress' && task.status !== 'todo') {
      throw new AppError(
        ErrorCode.STATE_CONFLICT,
        `Task must be in_progress or todo to complete (current: ${task.status})`,
      );
    }
    const activeRun = await prisma.executionRun.findFirst({
      where: { taskId: params.taskId, status: 'running' },
      select: { id: true, executorName: true },
    });
    if (activeRun) {
      throw new AppError(
        ErrorCode.STATE_CONFLICT,
        `Task has an active execution by "${activeRun.executorName}". Wait for it to complete.`,
      );
    }
    if (task.assignee !== auth.userName) {
      const member = await prisma.projectMember.findUnique({
        where: { projectId_name: { projectId: params.projectId, name: auth.userName } },
      });
      if (member?.role !== 'owner') {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          'Only the task assignee or a project owner can complete this task',
        );
      }
    }

    const taskPack = await buildTaskPack(params.taskId, params.projectId);

    await prisma.$transaction(async (tx) => {
      // Create and immediately complete a human execution run
      const run = await tx.executionRun.create({
        data: {
          taskId: params.taskId,
          executorType: 'human',
          executorName: auth.userName,
          boundPlanVersion: task.boundPlanVersion,
          status: 'completed',
          taskPackSnapshot: (taskPack ?? {}) as Prisma.InputJsonValue,
          outputSummary: body.completionNote,
          deliverablesMet:
            task.planDeliverableRefs.length > 0 ? task.planDeliverableRefs : [body.completionNote],
          filesChanged: [],
          blockers: [],
          driftSignals: [],
          lastHeartbeatAt: new Date(),
          endedAt: new Date(),
        },
      });

      // Mark task done and optionally update prUrl
      await tx.task.update({
        where: { id: params.taskId },
        data: {
          status: 'done',
          ...(body.prUrl ? { prUrl: body.prUrl } : {}),
        },
      });

      return run;
    });

    await createActivity({
      projectId: params.projectId,
      type: 'task_completed',
      actorName: auth.userName,
      actorType: 'human',
      summary: `"${task.title}" marked done by ${auth.userName}`,
      metadata: { taskId: params.taskId, note: body.completionNote },
    });

    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    return handleApiError(error);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { updateTaskSchema, AppError, ErrorCode } from '@plansync/shared';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { sendMail, userEmail } from '@/lib/email';
import { logger } from '@/lib/logger';

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

const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  todo: ['in_progress', 'cancelled'],
  in_progress: ['done', 'blocked', 'cancelled'],
  blocked: ['in_progress'],
};

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    const authed = await requireProjectRole(auth, params.projectId);
    const body = await validateBody(req, updateTaskSchema);

    // The plan*Refs fields together control (a) AI completion verification
    // scope and (b) drift severity classification per task. Letting an agent
    // narrow its own refs would let it silently disclaim accountability for
    // breaking changes — so all three are owner-only.
    if (
      body.planDeliverableRefs !== undefined ||
      body.planConstraintRefs !== undefined ||
      body.planStandardRefs !== undefined
    ) {
      await requireProjectRole(auth, params.projectId, 'owner');
    }

    const task = await prisma.task.findUnique({ where: { id: params.taskId } });
    if (!task) throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    if (task.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }

    if (body.status && body.status !== task.status) {
      const allowed = VALID_STATUS_TRANSITIONS[task.status];
      if (!allowed || !allowed.includes(body.status)) {
        throw new AppError(
          ErrorCode.STATE_CONFLICT,
          `Invalid status transition: ${task.status} → ${body.status}`,
        );
      }

      // Marking a task done is the single most consequential PATCH on this
      // route — it closes the loop on accountability for the assigned work.
      // Without a guard, any project member could PATCH any task (their own
      // or someone else's) straight to done, bypassing both execution
      // tracking and ownership oversight. The rules below mirror the three
      // legitimate ways a task can legitimately reach `done`:
      //   1. Project owner administratively closes it.
      //   2. A completed ExecutionRun exists (the normal flow via
      //      execution_complete).
      //   3. The current assignee finishes a human task themselves — but
      //      only for human-typed tasks (agent tasks always need a run).
      if (body.status === 'done') {
        const isOwner = authed.projectRole === 'owner';
        const completedRun = await prisma.executionRun.findFirst({
          where: { taskId: params.taskId, status: 'completed' },
        });
        const hasCompletedRun = completedRun !== null;
        const isHumanSelfComplete =
          task.assigneeType === 'human' && task.assignee === auth.userName;

        if (!isOwner && !hasCompletedRun && !isHumanSelfComplete) {
          if (task.assigneeType === 'agent') {
            throw new AppError(
              ErrorCode.STATE_CONFLICT,
              'Agent task cannot be marked done without a completed execution run.',
            );
          }
          throw new AppError(
            ErrorCode.FORBIDDEN,
            'Only the project owner, the current assignee (for human tasks), or execution_complete can mark a task done.',
          );
        }
      }
    }

    if (body.assignee !== undefined && body.assignee !== null && body.assignee !== task.assignee) {
      const member = await prisma.projectMember.findUnique({
        where: { projectId_name: { projectId: params.projectId, name: body.assignee } },
      });
      if (!member) {
        throw new AppError(
          ErrorCode.BAD_REQUEST,
          `Assignee "${body.assignee}" is not a member of this project`,
        );
      }
    }

    const updated = await prisma.task.update({
      where: { id: params.taskId },
      data: body,
    });

    if (body.assignee !== undefined && body.assignee !== task.assignee) {
      if (body.assignee === null) {
        eventBus.publish(params.projectId, 'task_unassigned', {
          taskId: params.taskId,
          previousAssignee: task.assignee,
        });
        dispatchWebhooks(params.projectId, 'task_unassigned', {
          taskId: params.taskId,
          title: updated.title,
          previousAssignee: task.assignee,
        });
      } else {
        eventBus.publish(params.projectId, 'task_assigned', {
          taskId: params.taskId,
          assignee: body.assignee,
        });
        dispatchWebhooks(params.projectId, 'task_assigned', {
          taskId: params.taskId,
          title: updated.title,
          assignee: body.assignee,
        });
        const assigneeMember = await prisma.projectMember.findUnique({
          where: { projectId_name: { projectId: params.projectId, name: body.assignee } },
          select: { type: true },
        });
        if (assigneeMember?.type === 'human') {
          const mailBody = [
            `You have been assigned task "${updated.title}".`,
            '',
            'Log in to PlanSync to view the task details.',
          ].join('\n');
          const ok = sendMail(
            [userEmail(body.assignee)],
            `[PlanSync] Task assigned: "${updated.title}"`,
            mailBody,
          );
          if (!ok) logger.warn({ taskId: params.taskId }, 'Failed to send task reassignment email');
        }
      }
    }

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
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

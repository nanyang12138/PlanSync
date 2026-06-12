import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { z } from 'zod';
import { validateBody, validateSearchParams } from '@/lib/validate';
import {
  createTaskSchema,
  paginationSchema,
  taskStatusSchema,
  AppError,
  ErrorCode,
} from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { sendMail, userEmail } from '@/lib/email';
import { logger } from '@/lib/logger';
import { syncTaskDeliverableLinks } from '@/lib/task-deliverable-links';

type Params = { params: Promise<{ projectId: string }> };

// R-042: validate task list query params against shared enums so that callers
// passing e.g. ?status=foo get a clear 400 instead of an empty result set.
const taskListQuerySchema = paginationSchema.extend({
  status: taskStatusSchema.optional(),
  assignee: z.string().trim().min(1).optional(),
  // R-207 / L3: server-side branchName filter. The GitHub Action drift-gate
  // previously had to paginate the whole task list and match `branchName`
  // client-side, capped at TASK_PAGE_CAP pages — large projects silently
  // truncated and could miss in-scope HIGH drifts (github-action index.ts:676
  // left a TODO asking for exactly this). Exposing the filter lets CI fetch
  // precisely the PR's task(s) in one call.
  branchName: z.string().trim().min(1).optional(),
});

export async function GET(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const {
      page = 1,
      pageSize = 20,
      status,
      assignee,
      branchName,
    } = validateSearchParams(req, taskListQuerySchema);
    const skip = (page - 1) * pageSize;

    const where = {
      projectId: params.projectId,
      ...(status ? { status } : {}),
      ...(assignee ? { assignee } : {}),
      ...(branchName ? { branchName } : {}),
    };

    const [tasks, total] = await Promise.all([
      prisma.task.findMany({ where, skip, take: pageSize, orderBy: { createdAt: 'desc' } }),
      prisma.task.count({ where }),
    ]);

    return NextResponse.json({
      data: tasks,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, createTaskSchema);

    const task = await prisma.$transaction(async (tx) => {
      const activePlan = await tx.plan.findFirst({
        where: { projectId: params.projectId, status: 'active' },
      });
      if (!activePlan) {
        throw new AppError(
          ErrorCode.STATE_CONFLICT,
          'No active plan. Activate a plan before creating tasks.',
        );
      }

      if (body.assignee) {
        const member = await tx.projectMember.findUnique({
          where: { projectId_name: { projectId: params.projectId, name: body.assignee } },
        });
        if (!member) {
          throw new AppError(
            ErrorCode.BAD_REQUEST,
            `Assignee "${body.assignee}" is not a member of this project`,
          );
        }
      }

      const created = await tx.task.create({
        data: {
          ...body,
          projectId: params.projectId,
          boundPlanVersion: activePlan.version,
        },
      });

      // R-153: seed `task_deliverable_links` for the new task. Done inside
      // the same transaction so a slug typo / unresolvable ref does not
      // produce a half-created task.
      await syncTaskDeliverableLinks(tx, {
        taskId: created.id,
        projectId: params.projectId,
        boundPlanVersion: activePlan.version,
        slugs: created.planDeliverableRefs,
      });

      return created;
    });

    await createActivity({
      projectId: params.projectId,
      type: 'task_created',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Task "${task.title}" created (bound to plan v${task.boundPlanVersion})`,
      metadata: { taskId: task.id, boundPlanVersion: task.boundPlanVersion },
    });

    eventBus.publish(params.projectId, 'task_created', {
      taskId: task.id,
      title: task.title,
      assignee: task.assignee,
      boundPlanVersion: task.boundPlanVersion,
    });
    dispatchWebhooks(params.projectId, 'task_created', {
      taskId: task.id,
      title: task.title,
      assignee: task.assignee,
      boundPlanVersion: task.boundPlanVersion,
    });

    if (task.assignee) {
      eventBus.publish(params.projectId, 'task_assigned', {
        taskId: task.id,
        title: task.title,
        assignee: task.assignee,
      });
      dispatchWebhooks(params.projectId, 'task_assigned', {
        taskId: task.id,
        title: task.title,
        assignee: task.assignee,
      });
      const assigneeMember = await prisma.projectMember.findUnique({
        where: { projectId_name: { projectId: params.projectId, name: task.assignee } },
        select: { type: true },
      });
      if (assigneeMember?.type === 'human') {
        const mailBody = [
          `You have been assigned task "${task.title}".`,
          '',
          'Log in to PlanSync to view the task details and start working.',
        ].join('\n');
        const ok = sendMail(
          [userEmail(task.assignee)],
          `[PlanSync] Task assigned: "${task.title}"`,
          mailBody,
        );
        if (!ok) logger.warn({ taskId: task.id }, 'Failed to send task assignment email');
      }
    }

    return NextResponse.json({ data: task }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { auditCrossProjectTaskIfNeeded } from '@/lib/task-scope';
import { acquireProjectAdvisoryLock } from '@/lib/advisory-lock';

type Params = { params: Promise<{ projectId: string; taskId: string }> };

export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    // R-135: scope by projectId so rebind cannot be invoked against a task in another project.
    const task = await prisma.task.findFirst({
      where: { id: params.taskId, projectId: params.projectId },
    });
    if (!task) {
      await auditCrossProjectTaskIfNeeded(
        params.taskId,
        params.projectId,
        'POST /tasks/:id/rebind',
      );
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }

    // R-004: rebind is "explicit restart" — reset non-terminal tasks to
    // `todo` and mark stale runs as `superseded`. Terminal states (`done`,
    // `cancelled`) preserve their status; only the version reference moves.
    const TERMINAL_TASK_STATES = ['done', 'cancelled'] as const;
    const { updated, oldVersion, newVersion } = await prisma.$transaction(async (tx) => {
      // Serialize per-project against a concurrent `plan_activate` and the
      // drift_resolve route. Without the lock, the active-plan read and the
      // bind below run at READ COMMITTED, so an activate that commits a newer
      // version between the read and the write would leave the task bound to a
      // now-superseded version. Acquired first so the lock-ordering matches
      // every other route that takes it.
      await acquireProjectAdvisoryLock(tx, params.projectId);

      // Read the active plan + task INSIDE the tx (after the lock) so the
      // version we bind to is authoritative once any in-flight activate has
      // committed.
      const activePlan = await tx.plan.findFirst({
        where: { projectId: params.projectId, status: 'active' },
      });
      if (!activePlan) {
        throw new AppError(ErrorCode.STATE_CONFLICT, 'No active plan to rebind to');
      }

      const liveTask = await tx.task.findUnique({
        where: { id: params.taskId },
        select: { status: true, boundPlanVersion: true },
      });
      if (!liveTask) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
      }
      if (liveTask.boundPlanVersion === activePlan.version) {
        throw new AppError(ErrorCode.STATE_CONFLICT, 'Task already bound to current active plan');
      }

      const isTerminal = (TERMINAL_TASK_STATES as readonly string[]).includes(liveTask.status);
      const t = await tx.task.update({
        where: { id: params.taskId },
        data: {
          boundPlanVersion: activePlan.version,
          ...(isTerminal ? {} : { status: 'todo' }),
          // R-140: clear executionGate so a subsequent execution_start is not
          // permanently blocked after rebind (mirrors drift_resolve action=rebind).
          executionGate: null,
        },
      });
      await tx.executionRun.updateMany({
        where: { taskId: params.taskId, status: { in: ['paused', 'running'] } },
        data: { status: 'superseded', endedAt: new Date() },
      });
      await tx.driftAlert.updateMany({
        where: { taskId: params.taskId, projectId: params.projectId, status: 'open' },
        data: {
          status: 'resolved',
          resolvedAction: 'rebind',
          resolvedAt: new Date(),
          resolvedBy: auth.userName,
        },
      });
      return { updated: t, oldVersion: liveTask.boundPlanVersion, newVersion: activePlan.version };
    });

    await createActivity({
      projectId: params.projectId,
      type: 'task_rebound',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Task "${task.title}" rebound from plan v${oldVersion} to v${newVersion}`,
      metadata: { taskId: task.id, oldVersion, newVersion },
    });

    eventBus.publish(params.projectId, 'drift_resolved', {
      taskId: params.taskId,
      title: task.title,
      resolvedBy: auth.userName,
      oldVersion,
      newVersion,
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

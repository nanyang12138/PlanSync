import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { resolveDriftSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';

type Params = { params: { projectId: string; driftId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    const member = await requireProjectRole(auth, params.projectId);
    const body = await validateBody(req, resolveDriftSchema);

    const drift = await prisma.driftAlert.findUnique({
      where: { id: params.driftId },
      include: { task: true },
    });
    if (!drift) throw new AppError(ErrorCode.NOT_FOUND, 'Drift alert not found');
    if (drift.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Drift alert not found');
    }

    const isOwner = member.projectRole === 'owner';
    const isAssignee = drift.task.assignee === auth.userName;
    if (!isOwner && !isAssignee) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Only project owners or the task assignee can resolve this drift alert',
      );
    }

    if (drift.status !== 'open') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Drift alert already resolved');
    }

    const activePlan = await prisma.plan.findFirst({
      where: { projectId: params.projectId, status: 'active' },
    });

    await prisma.$transaction(async (tx) => {
      await tx.driftAlert.update({
        where: { id: params.driftId },
        data: {
          status: 'resolved',
          resolvedAction: body.action,
          resolvedAt: new Date(),
          resolvedBy: auth.userName,
        },
      });

      if (body.action === 'no_impact' && drift.task.status === 'blocked') {
        await tx.task.update({
          where: { id: drift.taskId },
          data: { status: 'in_progress' },
        });
        // Intentionally do NOT auto-revive paused runs on no_impact: the agent's
        // mid-execution context is already gone (its tool stream was aborted on
        // the MCP RUN_PAUSED signal), so silently flipping the run back to
        // running would be inviting another inconsistent state. Owner must
        // start a fresh execution. The paused run row remains for forensics
        // until the pause-ack-timeout scanner sweeps it.
      } else if (body.action === 'rebind' && !activePlan) {
        throw new AppError(ErrorCode.STATE_CONFLICT, 'No active plan to rebind to');
      } else if (body.action === 'rebind' && activePlan) {
        // R-004: rebind semantics upgraded to "explicit restart". The task
        // is rebound to the new plan version AND reset to `todo` so that
        // any prior partial work is discarded and a fresh execution must
        // be started against the new plan. Terminal lifecycle states
        // (`done`, `cancelled`) are preserved — rebinding a finished task
        // only updates its version reference for audit. All other states
        // (`todo`, `in_progress`, `blocked`) collapse to `todo`.
        const TERMINAL_TASK_STATES = ['done', 'cancelled'] as const;
        const isTerminal = (TERMINAL_TASK_STATES as readonly string[]).includes(drift.task.status);
        await tx.task.update({
          where: { id: drift.taskId },
          data: {
            boundPlanVersion: activePlan.version,
            ...(isTerminal ? {} : { status: 'todo' }),
          },
        });
        // R-002 + R-004: rebind commits the task to the new plan version,
        // which makes any active run for this task irreversibly stale
        // (run.bound=v1, task.bound=v2). Move every non-terminal run to
        // 'superseded' so the run row's lifecycle is terminal and the
        // history reads clearly. Covers paused runs (drift-engine paused
        // them), running runs (low-severity drift that didn't pause), and
        // any future intermediate state.
        await tx.executionRun.updateMany({
          where: { taskId: drift.taskId, status: { in: ['paused', 'running'] } },
          data: { status: 'superseded', endedAt: new Date() },
        });
      } else if (body.action === 'cancel') {
        await tx.task.update({
          where: { id: drift.taskId },
          data: { status: 'cancelled' },
        });
        await tx.executionRun.updateMany({
          where: { taskId: drift.taskId, status: { in: ['running', 'paused'] } },
          data: { status: 'cancelled', endedAt: new Date() },
        });
      }
    });

    await createActivity({
      projectId: params.projectId,
      type: 'drift_resolved',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Drift alert resolved: ${body.action} for "${drift.task.title}"`,
      metadata: { driftId: drift.id, action: body.action, taskId: drift.taskId },
    });

    eventBus.publish(params.projectId, 'drift_resolved', {
      alertId: drift.id,
      action: body.action,
      resolvedBy: auth.userName,
    });
    dispatchWebhooks(params.projectId, 'drift_resolved', {
      alertId: drift.id,
      action: body.action,
      resolvedBy: auth.userName,
    });

    return NextResponse.json({ data: { resolved: true, action: body.action } });
  } catch (error) {
    return handleApiError(error);
  }
}

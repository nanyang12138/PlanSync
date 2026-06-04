import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { resolveDriftSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { acquireProjectAdvisoryLock } from '@/lib/advisory-lock';

type Params = { params: Promise<{ projectId: string; driftId: string }> };

export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
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

    // R-210: capture what `rebind` did to the task so we can emit a dedicated
    // `task_rebound` activity AFTER the tx commits. Without this, the rebind
    // branch's destructive side-effects (status reset to `todo`, in-flight
    // runs superseded) were invisible in the activity feed — only a generic
    // `drift_resolved` row was written, while the equivalent `/rebind` shortcut
    // route emits a `task_rebound` row. Mirrors the `cancel`→`task_cancelled`
    // precedent (R-107) in this same handler.
    type RebindAudit = {
      previousStatus: string;
      oldVersion: number;
      newVersion: number;
      wasReset: boolean;
    };
    let rebindAudit: RebindAudit | null = null;

    await prisma.$transaction(async (tx) => {
      // Serialize per-project against a concurrent `plan_activate` (which sets
      // executionGate / supersedes open alerts inside its own transaction)
      // and against the `/rebind` route. Without this, the active-plan read
      // and the gate-clear below run at READ COMMITTED and can rebind a task
      // to a version that a just-committed activate already superseded, or
      // clear a gate that activate set for a brand-new alert. Acquired first
      // so the lock-ordering matches every other route that takes it.
      await acquireProjectAdvisoryLock(tx, params.projectId);

      // R-051: the open-status gate above was evaluated on a pre-lock snapshot.
      // A concurrent activate may have superseded this alert (open → superseded)
      // and opened a fresh one for the same task while we waited on the lock.
      // Re-read inside the tx; if it is no longer open, this resolution is
      // stale — the owner should re-read drifts and act on the current alert.
      const liveDrift = await tx.driftAlert.findUnique({
        where: { id: params.driftId },
        select: { status: true },
      });
      if (liveDrift?.status !== 'open') {
        throw new AppError(
          ErrorCode.STATE_CONFLICT,
          'Drift alert was superseded or resolved concurrently (likely a newer plan ' +
            'activation). Re-read the task drifts and resolve the current alert.',
        );
      }

      // Re-read the active plan INSIDE the transaction (after the lock) so a
      // `rebind` binds to the version that is current once any in-flight
      // activate has committed — never a superseded snapshot read before the
      // lock was held. Only the rebind branch needs it.
      const activePlan =
        body.action === 'rebind'
          ? await tx.plan.findFirst({
              where: { projectId: params.projectId, status: 'active' },
            })
          : null;

      // Re-read the task status INSIDE the transaction (after the lock) too.
      // `drift.task.status` above was loaded on the pre-lock snapshot; a
      // concurrent update (e.g. a run completing to `done`, or another
      // resolution flipping to `cancelled`) may have committed while we waited
      // on the lock. Using the stale status to decide terminal-vs-reset would
      // let `rebind` clobber a just-committed terminal state back to `todo`
      // (and `no_impact` mis-detect the legacy `blocked` row). Mirror the
      // `/rebind` route, which reads `liveTask.status` in-tx for the same race.
      const liveTask = await tx.task.findUnique({
        where: { id: drift.taskId },
        select: { status: true, boundPlanVersion: true },
      });
      if (!liveTask) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
      }

      await tx.driftAlert.update({
        where: { id: params.driftId },
        data: {
          status: 'resolved',
          resolvedAction: body.action,
          resolvedAt: new Date(),
          resolvedBy: auth.userName,
        },
      });

      if (body.action === 'no_impact') {
        // R-140: clear the system gate but never touch task.status. Pre-R-140
        // history may have set status='blocked' from drift; we preserve a
        // narrow backwards-compat path that promotes those rows back to
        // 'in_progress' so existing dashboards don't see a stuck-blocked
        // row, but the new contract is "executionGate is the system-gate
        // signal; status is owner-meaningful". For tasks whose status was
        // never touched (the post-R-140 path), only the gate clears.
        await tx.task.update({
          where: { id: drift.taskId },
          data: {
            executionGate: null,
            ...(liveTask.status === 'blocked' ? { status: 'in_progress' } : {}),
          },
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
        //
        // R-140: rebind also clears executionGate so a subsequent
        // execution_start against the new plan is not blocked by the
        // system gate. The owner explicitly accepted the new plan; the
        // gate has served its purpose.
        const TERMINAL_TASK_STATES = ['done', 'cancelled'] as const;
        const isTerminal = (TERMINAL_TASK_STATES as readonly string[]).includes(liveTask.status);
        rebindAudit = {
          previousStatus: liveTask.status,
          oldVersion: liveTask.boundPlanVersion,
          newVersion: activePlan.version,
          wasReset: !isTerminal,
        };
        await tx.task.update({
          where: { id: drift.taskId },
          data: {
            boundPlanVersion: activePlan.version,
            executionGate: null,
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
        // R-140: cancel clears the gate as a side-effect of moving to a
        // terminal state. status='cancelled' is the authoritative signal;
        // leaving the gate set on a cancelled row would be confusing.
        await tx.task.update({
          where: { id: drift.taskId },
          data: { status: 'cancelled', executionGate: null },
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

    // R-107: drift `cancel` is the only action whose side-effect terminates
    // the task (status='cancelled'), but the `drift_resolved` activity above
    // only records *how the drift was answered*, not *what happened to the
    // task*. Without a paired `task_cancelled` row, an owner reading the
    // activity feed sees the drift acknowledgement and a task that quietly
    // disappeared from the active board — same audit gap R-105/R-106 closed
    // for PATCH and DELETE. Emit a dedicated row so the task lifecycle is
    // fully reconstructable from activities alone.
    //
    // Only write this for `cancel` — `no_impact` and `rebind` do not move
    // the task to a terminal state, so a `task_cancelled` row there would
    // be a lie. The drift_resolved row above remains the audit trail for
    // those two paths.
    if (body.action === 'cancel') {
      await createActivity({
        projectId: params.projectId,
        type: 'task_cancelled',
        actorName: auth.userName,
        actorType: 'human',
        summary: `Task "${drift.task.title}" cancelled via drift resolution`,
        metadata: {
          taskId: drift.taskId,
          title: drift.task.title,
          previousStatus: drift.task.status,
          driftId: drift.id,
          reason: 'drift_cancel',
        },
      });
    }

    // R-210: pair the generic `drift_resolved` row above with a dedicated
    // `task_rebound` row when rebind actually moved the task, so the feed
    // surfaces the destructive reset (status → todo, runs superseded) instead
    // of hiding it. Matches the `/rebind` shortcut route, which the docs call
    // an equivalent of `drift_resolve action=rebind`.
    if (body.action === 'rebind' && rebindAudit) {
      const a: RebindAudit = rebindAudit;
      const summary = a.wasReset
        ? `Task "${drift.task.title}" rebound v${a.oldVersion} → v${a.newVersion}; status reset ${a.previousStatus} → todo and in-flight run(s) superseded`
        : `Task "${drift.task.title}" rebound v${a.oldVersion} → v${a.newVersion} (terminal status ${a.previousStatus} preserved)`;
      await createActivity({
        projectId: params.projectId,
        type: 'task_rebound',
        actorName: auth.userName,
        actorType: 'human',
        summary,
        metadata: {
          taskId: drift.taskId,
          title: drift.task.title,
          oldVersion: a.oldVersion,
          newVersion: a.newVersion,
          previousStatus: a.previousStatus,
          wasReset: a.wasReset,
          driftId: drift.id,
          reason: 'drift_rebind',
        },
      });
    }

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

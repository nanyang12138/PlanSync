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
import { auditCrossProjectTaskIfNeeded } from '@/lib/task-scope';
import { acquireProjectAdvisoryLock } from '@/lib/advisory-lock';

type Params = { params: Promise<{ projectId: string; taskId: string }> };

export async function GET(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const { page = 1, pageSize = 20 } = validateSearchParams(req, paginationSchema);
    const skip = (page - 1) * pageSize;

    const task = await prisma.task.findFirst({
      where: { id: params.taskId, projectId: params.projectId },
    });
    if (!task) {
      await auditCrossProjectTaskIfNeeded(params.taskId, params.projectId, 'GET /tasks/:id/runs');
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }

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

export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const rawAuth = await authenticate(req);
    const auth = await requireProjectRole(rawAuth, params.projectId);
    const body = await validateBody(req, createExecutionRunSchema);

    // R-135: scope by projectId so execution_start cannot be invoked against a task in another project.
    const task = await prisma.task.findFirst({
      where: { id: params.taskId, projectId: params.projectId },
    });
    if (!task) {
      await auditCrossProjectTaskIfNeeded(params.taskId, params.projectId, 'POST /tasks/:id/runs');
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }

    // R-140: system-gated tasks (drift_high / drift_medium / manual_block)
    // cannot start a new execution until the gate is cleared by
    // drift_resolve. This check runs before the status check below so the
    // error message points the operator at the right recovery action
    // (resolve the drift) rather than implying the task lifecycle is wrong.
    if (task.executionGate) {
      const gateMsg =
        task.executionGate === 'drift_high' || task.executionGate === 'drift_medium'
          ? `Cannot start execution: task is gated by drift (${task.executionGate}). Resolve open drift alerts (drift_resolve action=rebind|no_impact|cancel) before retrying.`
          : `Cannot start execution: task is gated (${task.executionGate}). Clear the gate before retrying.`;
      throw new AppError(ErrorCode.STATE_CONFLICT, gateMsg, {
        executionGate: task.executionGate,
      });
    }

    // R-054: Only 'todo', 'in_progress', or 'awaiting_evidence' tasks may
    // start a new execution run. Previously, a 'done', 'cancelled', or
    // 'blocked' task would silently fall through both status branches
    // below and create a run with the task in a terminal/blocked state —
    // corrupting status invariants (a 'done' task could end up with a
    // fresh running run hanging off it). Reject up front and direct the
    // caller to the right recovery action.
    //
    // R-192 / closes #1218 #1215 #1210 #1203 #1196 #1187 #1180 #1176
    // #1172 #1158 #1150 #1135 #1122 #1082 #1077 — `awaiting_evidence`
    // is treated like `in_progress` here so that the agent (or the
    // owner, after the missing PR / commit landed) can start a fresh
    // run, supply the evidence, and re-enter `execution_complete` to
    // get the R-192 gate to flip the task to `done`. Without this
    // branch, the task was stuck: the original run had already finished
    // (status='completed'), so it could not be re-completed, and a new
    // run was rejected here.
    if (
      task.status !== 'todo' &&
      task.status !== 'in_progress' &&
      task.status !== 'awaiting_evidence'
    ) {
      throw new AppError(
        ErrorCode.STATE_CONFLICT,
        `Cannot start execution: task is "${task.status}". Only "todo", "in_progress", or "awaiting_evidence" tasks may start a new run. ` +
          (task.status === 'blocked'
            ? 'Resolve open drift alerts (or PATCH the task back to in_progress) before retrying.'
            : task.status === 'done'
              ? 'Reopen the task by PATCHing status back to "todo" first.'
              : task.status === 'cancelled'
                ? 'Cancelled tasks cannot be restarted; create a new task instead.'
                : 'Set the task status to "todo" or "in_progress" before retrying.'),
        { taskStatus: task.status },
      );
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

      // R-012: Don't auto-register unknown agents. Previously, any developer could call
      // execution_start with an arbitrary executorName and silently add that agent as a
      // project member. Now: the agent must already be a member, OR the caller must be an
      // owner explicitly passing ?auto_register=true to opt into auto-provisioning.
      const existingAgent = await prisma.projectMember.findUnique({
        where: { projectId_name: { projectId: params.projectId, name: body.executorName } },
      });

      if (!existingAgent) {
        const autoRegister = req.nextUrl.searchParams.get('auto_register') === 'true';
        const isOwner = auth.projectRole === 'owner';
        if (!autoRegister || !isOwner) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            `Agent "${body.executorName}" is not a registered member of this project. Ask the project owner to add the agent (or, if you are the owner, pass ?auto_register=true to auto-provision).`,
          );
        }
        await prisma.projectMember.create({
          data: {
            projectId: params.projectId,
            name: body.executorName,
            role: 'developer',
            type: 'agent',
          },
        });
      } else if (existingAgent.type !== 'agent') {
        // The name exists but is registered as a human member — refuse to execute as an
        // agent under a human's identity. The human would need to start the run themselves
        // via executorType:'human'.
        throw new AppError(
          ErrorCode.FORBIDDEN,
          `Member "${body.executorName}" is registered as a human; cannot start agent execution under this name.`,
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

    // Fixes #1467 — the upfront `task` read at the top of this handler
    // happens OUTSIDE any transaction, so a concurrent `PATCH /tasks/:id`
    // that lands between the read and the writes below can leave us
    // creating a `running` execution_run on a task that is no longer in
    // a legal source state (e.g. PATCH already advanced it to
    // `done`/`cancelled`/`blocked`). Two specific gaps existed pre-fix:
    //
    //   1. The `awaiting_evidence` branch called `updateMany` with a
    //      `status: 'awaiting_evidence'` guard but never inspected
    //      `count`. If the guard matched zero rows (because PATCH had
    //      already flipped status), the code silently fell through and
    //      created a running run — violating the R-054 state invariant.
    //
    //   2. The `in_progress` branch performed no state write at all, so
    //      a PATCH that flipped `in_progress → done` between the upfront
    //      read and the `executionRun.create` would still produce a
    //      running run hanging off a `done` task.
    //
    // The fix wraps the state-transition decisions and the run create in
    // a single `$transaction` and, inside it, re-evaluates task.status
    // with `findUnique` plus uses conditional `updateMany` writes with
    // explicit `count` checks (PostgreSQL takes a row-level write lock
    // on UPDATE — including no-op self-sets — so subsequent reads in the
    // same tx see a stable view). Concurrent PATCHes now either lose the
    // race (we throw STATE_CONFLICT) or commit cleanly before this tx
    // starts (we observe their result on re-read and reject appropriately).
    let run;
    try {
      run = await prisma.$transaction(async (tx) => {
        // R-206: serialize against in-flight `plan_activate` for this same
        // project. Without this, the outer `task.findFirst` above (line 58)
        // runs at READ COMMITTED and cannot see the `executionGate` that
        // activate sets inside its own transaction. With the lock, this
        // tx blocks until activate commits, and the `liveTask` re-read
        // below observes the gate; the existing R-140 guards and the
        // `executionGate: null` WHERE clauses in the updateMany calls
        // further down then reject cleanly with STATE_CONFLICT.
        await acquireProjectAdvisoryLock(tx, params.projectId);
        const liveTask = await tx.task.findUnique({
          where: { id: params.taskId },
          select: { status: true, boundPlanVersion: true, executionGate: true },
        });
        if (!liveTask) {
          throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
        }

        // R-206: re-check the gate in-tx now that any in-flight activate
        // has committed (advisory lock above guarantees ordering). The
        // outer R-140 check at line 71 ran on a pre-lock snapshot and may
        // have missed a concurrent activate. Mirror the outer message so
        // the operator sees the same recovery hint either way.
        if (liveTask.executionGate) {
          const gateMsg =
            liveTask.executionGate === 'drift_high' || liveTask.executionGate === 'drift_medium'
              ? `Cannot start execution: task is gated by drift (${liveTask.executionGate}). Resolve open drift alerts (drift_resolve action=rebind|no_impact|cancel) before retrying.`
              : `Cannot start execution: task is gated (${liveTask.executionGate}). Clear the gate before retrying.`;
          throw new AppError(ErrorCode.STATE_CONFLICT, gateMsg, {
            executionGate: liveTask.executionGate,
          });
        }

        if (liveTask.status === 'todo') {
          // Atomic claim: transition from 'todo' → 'in_progress' in a single DB operation.
          // If two operators race on the same todo task, only one wins — the other gets count=0.
          // R-206: `executionGate: null` belt-and-suspenders — the in-tx check
          // above already throws on a set gate, but pinning it here means a
          // future non-activate gate-setter (e.g. manual_block API) still
          // cannot slip a claim past us.
          const claimed = await tx.task.updateMany({
            where: { id: params.taskId, status: 'todo', executionGate: null },
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
        } else if (liveTask.status === 'in_progress' || liveTask.status === 'awaiting_evidence') {
          // Mutex: only one running run per task. Stale/failed/completed runs allow retry.
          // task.assignee is preserved — set on the original todo→in_progress claim, not rewritten here.
          const activeRun = await tx.executionRun.findFirst({
            where: { taskId: params.taskId, status: 'running' },
            select: { id: true, executorName: true, lastHeartbeatAt: true },
          });
          if (activeRun) {
            throw new AppError(
              ErrorCode.STATE_CONFLICT,
              `Task already has an active execution by "${activeRun.executorName}" (runId: ${activeRun.id}). Wait for it to complete, fail, or go stale (5min heartbeat timeout).`,
            );
          }
          if (liveTask.status === 'awaiting_evidence') {
            // R-192: a fresh run after an `awaiting_evidence` parking lifts the
            // task back into `in_progress` so the rest of the route (event
            // payloads, drift gating, status displays) sees a normal run/task
            // pair. The next `execution_complete` re-derives the R-192 state
            // and will flip to `done` once the missing evidence is in place.
            //
            // Fixes #1467 — guard on `awaiting_evidence` AND check count. A
            // concurrent PATCH that flipped the task to `done`/`cancelled`/
            // `blocked` would otherwise let us fall through to a running-run
            // INSERT on a terminal task.
            const lifted = await tx.task.updateMany({
              // R-206: `executionGate: null` defense in depth (see #1467
              // comment block; same rationale as the todo→in_progress
              // claim above).
              where: { id: params.taskId, status: 'awaiting_evidence', executionGate: null },
              data: { status: 'in_progress' },
            });
            if (lifted.count === 0) {
              throw new AppError(
                ErrorCode.STATE_CONFLICT,
                `Task status changed during execution start — retry after re-reading task state`,
              );
            }
          } else {
            // liveTask.status === 'in_progress' — no transition needed, but we
            // still must guarantee status doesn't flip out from under us
            // before the run INSERT. A no-op self-set updateMany with the
            // `status: 'in_progress'` guard (a) takes a row-level write lock
            // on the task for the rest of the tx and (b) lets us detect a
            // racing PATCH via count=0. Fixes #1467.
            const verified = await tx.task.updateMany({
              // R-206: `executionGate: null` defense in depth — same
              // rationale as the other two updateMany guards in this tx.
              where: { id: params.taskId, status: 'in_progress', executionGate: null },
              data: { status: 'in_progress' },
            });
            if (verified.count === 0) {
              throw new AppError(
                ErrorCode.STATE_CONFLICT,
                `Task status changed during execution start — retry after re-reading task state`,
              );
            }
          }
        } else {
          // Status changed between the upfront read (which passed the R-054
          // gate above) and the tx (e.g. PATCH set it to 'done' /
          // 'cancelled' / 'blocked'). Reject rather than silently create a
          // running run on a now-illegal source state.
          throw new AppError(
            ErrorCode.STATE_CONFLICT,
            `Task status changed to "${liveTask.status}" during execution start — retry after re-reading task state`,
            { taskStatus: liveTask.status },
          );
        }

        return await tx.executionRun.create({
          data: {
            taskId: params.taskId,
            executorType: body.executorType,
            executorName: body.executorName,
            boundPlanVersion: liveTask.boundPlanVersion,
            status: 'running',
            taskPackSnapshot: taskPack as object,
            lastHeartbeatAt: new Date(),
            filesChanged: [],
            blockers: [],
            driftSignals: [],
          },
        });
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

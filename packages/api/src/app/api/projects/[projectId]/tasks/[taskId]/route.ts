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
import { auditCrossProjectTaskIfNeeded } from '@/lib/task-scope';
import { createActivity } from '@/lib/activity';
import { syncTaskDeliverableLinks } from '@/lib/task-deliverable-links';

type Params = { params: Promise<{ projectId: string; taskId: string }> };

export async function GET(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    // R-135: scope by projectId so a member of project A cannot read tasks
    // that live in project B by guessing/leaking task ids.
    const task = await prisma.task.findFirst({
      where: { id: params.taskId, projectId: params.projectId },
      include: { executionRuns: { orderBy: { startedAt: 'desc' }, take: 5 } },
    });
    if (!task) {
      // #255: cross-project audit signal on every read path, not just /pack.
      await auditCrossProjectTaskIfNeeded(params.taskId, params.projectId, 'GET /tasks/:id');
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }

    return NextResponse.json({ data: task });
  } catch (error) {
    return handleApiError(error);
  }
}

// R-192 / closes #1218 #1215 #1210 #1203 #1196 #1187 #1180 #1176
// #1172 #1158 #1150 #1135 #1122 #1082 #1077 — `awaiting_evidence` is
// the gate's "evidence-pending" pause: the run finished, the work is
// arguably done, but git/rule signals are still missing. Without
// explicit out-transitions the task was a dead-end (no PATCH, no new
// run). We give it the same exits as `in_progress`: forward to `done`
// (owner override after evidence finally lands), back to `in_progress`
// (owner reopens for more work), `blocked` (drift / external block
// arrived), or `cancelled`.
const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  todo: ['in_progress', 'cancelled'],
  in_progress: ['done', 'blocked', 'cancelled', 'awaiting_evidence'],
  awaiting_evidence: ['done', 'in_progress', 'blocked', 'cancelled'],
  blocked: ['in_progress'],
};

export async function PATCH(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
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

    // R-135: scope by projectId so cross-project taskIds 404 instead of leaking metadata.
    const task = await prisma.task.findFirst({
      where: { id: params.taskId, projectId: params.projectId },
    });
    if (!task) {
      // #256: write-path audit signal — visible alongside the buildTaskPack
      // / GET /pack signals so a probe sequence is fully traceable.
      await auditCrossProjectTaskIfNeeded(params.taskId, params.projectId, 'PATCH /tasks/:id');
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

      // R-192 / closes #1323 — `awaiting_evidence` exit-permission gate.
      //
      // The `→ done` branch below already blocks non-owner PATCHes from
      // `awaiting_evidence` straight to `done`, but a non-owner can still
      // launder past it in two hops:
      //   1. PATCH `awaiting_evidence → in_progress` (the source-state
      //      pivot used by the `→ done` guard never sees this hop).
      //   2. PATCH `in_progress → done`. The latest-run check is the
      //      only remaining defence — and as soon as another `running`
      //      run is created (or the old completed run is still the
      //      latest), `hasCompletedRun` can flip true again and the
      //      transition silently lands.
      // A `awaiting_evidence → blocked → in_progress → done` variant
      // works the same way because `blocked → in_progress` is also a
      // permitted hop.
      //
      // Close the family by gating the FIRST hop instead: if the source
      // state is `awaiting_evidence` and the caller is not the project
      // owner, the only legitimate target is `cancelled` (the assignee
      // releasing the task). All other recovery flows for non-owners go
      // through `POST /runs`, which creates a fresh ExecutionRun and
      // lets the next `execution_complete` re-derive the R-192 gate
      // against new evidence — that path is unchanged.
      if (
        task.status === 'awaiting_evidence' &&
        body.status !== 'cancelled' &&
        authed.projectRole !== 'owner'
      ) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          'Only the project owner can move a task out of awaiting_evidence (other than cancelling it). ' +
            'To re-supply evidence, start a new execution via POST /runs and let execution_complete re-evaluate the R-192 gate.',
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

        // R-192 / closes #1227 #1306 — `awaiting_evidence` is the gate's
        // parked state: a run *already* completed and R-192 explicitly
        // judged the evidence (PR merged, commit-deliverable links, open
        // drift) insufficient. A parked task therefore *always* has a
        // completed run on file (that's how it got parked), which makes
        // the `hasCompletedRun` shortcut below silently match and let any
        // member flip `awaiting_evidence → done`, bypassing the R-192
        // gate. Same threat for the human-self-complete shortcut: an
        // assignee who failed the gate must not be able to override it
        // themselves. The legitimate "owner override after evidence
        // finally lands" path is the documented exit on
        // `VALID_STATUS_TRANSITIONS`; enforce it here.
        if (task.status === 'awaiting_evidence' && !isOwner) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            'Only the project owner can mark an awaiting_evidence task done. ' +
              'Re-run execution_complete with fresh evidence to satisfy the R-192 gate.',
          );
        }

        // R-192 / closes #1306 — Anchor the "completed run exists"
        // shortcut on the *latest* run for this task, not on "any
        // completed run anywhere in history". The bypass closed here is:
        //
        //   1. Task is parked in `awaiting_evidence` (old completed run
        //      sits on file because R-192 rejected its evidence).
        //   2. Non-owner calls POST /runs on the parked task, which lifts
        //      it back to `in_progress` and creates a new `running` run.
        //   3. Non-owner PATCHes `status: 'done'`. The source state is
        //      now `in_progress` (so the awaiting_evidence guard above
        //      doesn't fire), and the OLD completed run still satisfies
        //      `hasCompletedRun`, so the shortcut greenlits the flip and
        //      R-192 is bypassed exactly as in the parked-PATCH attack.
        //
        // Looking at the *latest* run instead closes this: after step 2
        // the latest run is `running` (or later `failed`/`stale`/
        // `cancelled`/`superseded`), so `hasCompletedRun` is false and
        // the non-owner caller must wait for execution_complete to
        // re-run the R-192 gate against the new evidence. The
        // documented legitimate flow (`in_progress` with the most
        // recent run already `completed` → a member closes the loop)
        // is unchanged because in that scenario the latest run *is*
        // the completed one.
        const latestRun = await prisma.executionRun.findFirst({
          where: { taskId: params.taskId },
          orderBy: { startedAt: 'desc' },
          select: { status: true },
        });
        const hasCompletedRun = latestRun?.status === 'completed';
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

    // R-153: when the legacy slug array is rewritten by the owner, keep the
    // `task_deliverable_links` middle table in sync. The link rows are the
    // source of truth that survives slug renames; the slug array is the
    // human-friendly mirror that drives this resolve step.
    if (body.planDeliverableRefs !== undefined) {
      await syncTaskDeliverableLinks(undefined, {
        taskId: updated.id,
        projectId: updated.projectId,
        boundPlanVersion: updated.boundPlanVersion,
        slugs: body.planDeliverableRefs,
      });
    }

    // R-105: audit-log task PATCH effects. PATCH is the canonical mutation
    // surface for status flips and assignee changes, but until now only the
    // execution-driven mutations (claim, complete-human, execution_complete)
    // wrote activity rows — owner / member edits via PATCH bypassed the
    // audit log entirely, which hides accountability for status flips
    // (todo→blocked, blocked→in_progress) and reassignments from one
    // member to another. We emit one row per axis that changed so the
    // activity feed reflects exactly what the caller asked for.
    if (body.status && body.status !== task.status) {
      await createActivity({
        projectId: params.projectId,
        type: 'task_status_changed',
        actorName: auth.userName,
        actorType: 'human',
        summary: `Task "${updated.title}" status ${task.status} → ${body.status}`,
        metadata: {
          taskId: params.taskId,
          fromStatus: task.status,
          toStatus: body.status,
        },
      });
    }

    if (body.assignee !== undefined && body.assignee !== task.assignee) {
      await createActivity({
        projectId: params.projectId,
        type: 'task_reassigned',
        actorName: auth.userName,
        actorType: 'human',
        summary:
          body.assignee === null
            ? `Task "${updated.title}" unassigned (was ${task.assignee})`
            : `Task "${updated.title}" reassigned ${task.assignee} → ${body.assignee}`,
        metadata: {
          taskId: params.taskId,
          fromAssignee: task.assignee,
          toAssignee: body.assignee,
        },
      });

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

export async function DELETE(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');

    // R-135: scope DELETE lookup by projectId — same defense-in-depth as PATCH/GET.
    const task = await prisma.task.findFirst({
      where: { id: params.taskId, projectId: params.projectId },
    });
    if (!task) {
      await auditCrossProjectTaskIfNeeded(params.taskId, params.projectId, 'DELETE /tasks/:id');
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }

    // R-047: A `DELETE task` while an ExecutionRun is `running` would silently
    // cascade-delete the run record, orphaning a live agent's heartbeats and
    // its exec-scoped API key. The owner must explicitly cancel the run first
    // (via /runs/[runId] action=cancel) so audit + key revocation happen
    // through the normal path.
    const runningRun = await prisma.executionRun.findFirst({
      where: { taskId: params.taskId, status: 'running' },
      select: { id: true, executorName: true, startedAt: true },
    });
    if (runningRun) {
      throw new AppError(
        ErrorCode.STATE_CONFLICT,
        'Task has a running execution; cancel the run before deleting.',
        {
          runId: runningRun.id,
          executorName: runningRun.executorName,
          startedAt: runningRun.startedAt.toISOString(),
        },
      );
    }

    await prisma.task.delete({ where: { id: params.taskId } });

    // R-106: audit-log task DELETE. DELETE is the most destructive mutation
    // on the task surface — without an activity row, an owner removing a
    // task leaves no trace in the audit feed, breaking accountability for
    // scope shrinkage. We write `task_deleted` *after* the delete succeeds
    // (so a failed delete does not produce a spurious row) and capture the
    // pre-delete snapshot of the fields most useful for forensics: title,
    // status, assignee, and the plan version the task was bound to.
    await createActivity({
      projectId: params.projectId,
      type: 'task_deleted',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Task "${task.title}" deleted`,
      metadata: {
        taskId: params.taskId,
        title: task.title,
        status: task.status,
        assignee: task.assignee,
        assigneeType: task.assigneeType,
        boundPlanVersion: task.boundPlanVersion,
      },
    });

    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    return handleApiError(error);
  }
}

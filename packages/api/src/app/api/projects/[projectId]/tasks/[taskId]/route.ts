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

      // closes #1431 — `awaiting_evidence → cancelled` is the only
      // non-owner exit we leave open from the R-192 parked state
      // (assignee release escape hatch: "I give up on this task; the
      // gate will never pass and someone else should pick it up").
      // Without an assignee check, that exit is wide open to any
      // project member because the rest of this route only requires
      // `requireProjectRole` (member+). That means any developer can
      // cancel another human's or an agent's parked task, throwing
      // away the prior execution run's evidence and silently closing
      // out work that is not theirs. Restrict cancellation to either
      // the project owner (administrative close) or the current
      // assignee (the legitimate self-release path). Exec-scoped
      // agent keys set `auth.userName` to the executor name, which is
      // exactly the task's `assignee` for agent tasks, so the agent
      // doing its own cleanup is unaffected.
      if (body.status === 'cancelled' && task.status === 'awaiting_evidence') {
        const isOwner = authed.projectRole === 'owner';
        const isAssignee = task.assignee !== null && auth.userName === task.assignee;
        if (!isOwner && !isAssignee) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            'Only the project owner or the task assignee can cancel an awaiting_evidence task.',
          );
        }
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
          select: { status: true, endedAt: true },
        });

        // R-192 / closes #1404 — PATCH-based "lift from awaiting_evidence"
        // does not create a new ExecutionRun (unlike POST /runs, which
        // #1306 anchored on the latest run). So the latest run remains
        // the OLD completed run whose evidence R-192 already rejected,
        // and the bypass chain
        //
        //   1. PATCH awaiting_evidence → in_progress  (allowed for the
        //      assignee since #1434; no new run created)
        //   2. PATCH in_progress       → done
        //
        // sails past both shortcuts below: the source state at step 2
        // is `in_progress` so the direct-awaiting_evidence guard above
        // does not fire, `latestRun.status === 'completed'` still
        // matches (stale run), and `isHumanSelfComplete` matches for
        // the human assignee variant of the same chain.
        //
        // Detect the chain by reading the activity log: a
        // `task_status_changed` row with `fromStatus = 'awaiting_evidence'`
        // and `createdAt > latestRun.endedAt` means the lift happened
        // AFTER the latest completed run finished and no new run has
        // completed since, so the latest run is no longer authoritative
        // evidence for the current task lifecycle. We disable BOTH the
        // hasCompletedRun shortcut and the isHumanSelfComplete shortcut
        // in that case so the only non-owner exit is to re-run
        // execution_complete (which writes a new completed run on top
        // and re-fires the R-192 gate against fresh evidence).
        //
        // The legitimate "owner reopens → new run completes → a member
        // closes the loop" flow is unaffected: the new completed run's
        // endedAt is later than the lift activity, so the existence
        // check below misses and the shortcuts stay enabled.
        let liftedFromAwaitingEvidenceAfterLatestRun = false;
        if (latestRun?.endedAt) {
          const liftActivity = await prisma.activity.findFirst({
            where: {
              projectId: params.projectId,
              type: 'task_status_changed',
              createdAt: { gt: latestRun.endedAt },
              AND: [
                { metadata: { path: ['taskId'], equals: params.taskId } },
                { metadata: { path: ['fromStatus'], equals: 'awaiting_evidence' } },
              ],
            },
            select: { id: true },
          });
          liftedFromAwaitingEvidenceAfterLatestRun = liftActivity !== null;
        }

        const hasCompletedRun =
          latestRun?.status === 'completed' && !liftedFromAwaitingEvidenceAfterLatestRun;
        const isHumanSelfComplete =
          task.assigneeType === 'human' &&
          task.assignee === auth.userName &&
          !liftedFromAwaitingEvidenceAfterLatestRun;

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

      // R-192 / closes #1429 — third-party bypass via
      // `awaiting_evidence → in_progress|blocked → cancelled`.
      // PR #1428 added an owner-or-assignee gate for the direct
      // `awaiting_evidence → cancelled` PATCH. On its own that gate is
      // bypassable because the other two non-`done` exits of
      // `awaiting_evidence` (`→ in_progress`, `→ blocked`) carry no
      // identity check: any project member can flip the parked task
      // out of `awaiting_evidence` first, then run `in_progress →
      // cancelled` (or `blocked → in_progress → cancelled`) where the
      // owner-or-assignee gate no longer fires because the source
      // state is no longer `awaiting_evidence`.
      //
      // Close the bypass at the source by mirroring the same
      // owner-or-assignee authority model on the other parking-exit
      // PATCHes. The legitimate use of these transitions — owner
      // reopens for more work, or assignee resumes / marks blocked
      // after the gate parked it — is unchanged; only third-party
      // members lose the ability to unilaterally lift another
      // member's (or an agent's) parked task.
      //
      // `→ done` is intentionally left to the (stricter) owner-only
      // gate above. `→ cancelled` from `awaiting_evidence` is left to
      // PR #1428's gate so the two PRs compose without conflict; if
      // PR #1428 does not land, the direct `→ cancelled` hole remains
      // an open finding (#1426) but is out of scope for this fix —
      // this fix targets the bypass chain identified by #1429.
      //
      // The POST /runs recovery path is untouched: it has its own
      // assignee/agent identity checks (`task.assignee === executorName`
      // for agent tasks) and is the documented R-192 recovery shape.
      if (
        task.status === 'awaiting_evidence' &&
        (body.status === 'in_progress' || body.status === 'blocked')
      ) {
        const isOwner = authed.projectRole === 'owner';
        const isAssignee = task.assignee === auth.userName;
        if (!isOwner && !isAssignee) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            'Only the project owner or task assignee can resume or block an awaiting_evidence task. ' +
              'Use execution_start (POST /runs) for the documented R-192 recovery path.',
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

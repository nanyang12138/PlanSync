import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { buildTaskPack } from '@/lib/task-pack';
import { eventBus } from '@/lib/event-bus';
import { auditCrossProjectTaskIfNeeded } from '@/lib/task-scope';
import { deriveTaskCompletionState } from '@/lib/task-state-machine';
import { evaluateProjectVerificationRules } from '@/lib/verification-rules';

const schema = z.object({
  completionNote: z.string().min(1).max(5000),
  prUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'PR URL must use http(s)')
    .optional()
    .or(z.literal('')),
});

type Params = { params: Promise<{ projectId: string; taskId: string }> };

export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    const authed = await requireProjectRole(auth, params.projectId);

    const body = schema.parse(await req.json());

    // R-135: scope by projectId so complete-human cannot mark a task in another project as done.
    const task = await prisma.task.findFirst({
      where: { id: params.taskId, projectId: params.projectId },
    });
    if (!task) {
      await auditCrossProjectTaskIfNeeded(
        params.taskId,
        params.projectId,
        'POST /tasks/:id/complete-human',
      );
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
    const isOwner = authed.projectRole === 'owner';
    if (task.assignee !== auth.userName && !isOwner) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Only the task assignee or a project owner can complete this task',
      );
    }

    // Effective PR URL for this completion: a human may attach a PR in the
    // same request (`body.prUrl`). The R-181 verification-rule gate
    // (`require_pr_merged`) must evaluate against the PR being attached now,
    // not only the previously-stored `task.prUrl`.
    const effectivePrUrl = body.prUrl && body.prUrl.length > 0 ? body.prUrl : task.prUrl;

    // R-192 / closes #1476 — laundering bypass via
    // `awaiting_evidence → in_progress → POST /complete-human`.
    //
    // PATCH /tasks already enforces an owner-only gate on the direct
    // `awaiting_evidence → done` flip (route.ts: "Only the project
    // owner can mark an awaiting_evidence task done"), and #1306
    // anchored the PATCH `hasCompletedRun` shortcut on the *latest*
    // run so the `awaiting_evidence → POST /runs → PATCH done`
    // bypass is closed. The third path — `awaiting_evidence →
    // PATCH in_progress → POST /complete-human` — had no equivalent
    // check: complete-human creates a fresh `completed` run + flips
    // task → done without ever re-evaluating the R-192 evidence
    // that the gate originally rejected.
    //
    // Signal that we are sitting on a previously-parked task:
    // `latestRun?.status === 'completed'` while the task is back in
    // a non-terminal state. `VALID_STATUS_TRANSITIONS` has no exit
    // from `done`, so the only way to reach this combination is the
    // parking + reopen sequence (`awaiting_evidence → in_progress`
    // allowed for the assignee by #1429).
    //
    // When that signal fires we re-run `deriveTaskCompletionState`.
    // If the R-192 gate would still park the task (evidence still
    // missing), only the owner can override — matching the PATCH
    // route's `awaiting_evidence → done` owner-only invariant. The
    // assignee may still self-complete once the evidence lands (gate
    // returns `done`). A first-time self-complete (no `completed` run
    // on file) is INTENTIONALLY NOT gated here: humans completing for
    // the first time are trusted to attest to their own work, and the
    // first-time-done behaviour is locked in by
    // issue-1476-complete-human-r192-bypass.test.ts (the agent path is
    // gated because an agent's self-report cannot be trusted; a human
    // manual completion is itself the attestation). We use
    // `effectivePrUrl` so a human who attaches the now-merged PR in
    // this request can clear the gate and complete cleanly.
    if (!isOwner) {
      const latestRun = await prisma.executionRun.findFirst({
        where: { taskId: params.taskId },
        orderBy: { startedAt: 'desc' },
        select: { status: true },
      });
      if (latestRun?.status === 'completed') {
        const r192 = await deriveTaskCompletionState({
          projectId: params.projectId,
          task: {
            id: task.id,
            prUrl: effectivePrUrl,
            planDeliverableRefs: task.planDeliverableRefs ?? [],
            boundPlanVersion: task.boundPlanVersion,
          },
        });
        if (r192.gateApplied && r192.status === 'awaiting_evidence') {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            'Task was previously parked in awaiting_evidence by the R-192 gate ' +
              'and the missing evidence has not landed yet. Only the project ' +
              'owner can complete it without re-evaluation; otherwise call ' +
              'execution_complete to re-run the R-192 gate against fresh evidence.',
            { code: 'R192_AWAITING_EVIDENCE', missing: r192.missing },
          );
        }
      }
    }

    // R-046: Reuse the same open-drift gate as runs/[runId] complete. Without
    // this, a human-assigned task with an unresolved drift alert could be
    // marked done by simply calling complete-human, bypassing the alignment
    // check that agent executions are subject to. Mirror the runs/[runId]
    // implementation: return a structured 409 with the open drift list so the
    // CLI / Web UI can show actionable guidance.
    const openDrifts = await prisma.driftAlert.findMany({
      where: { taskId: params.taskId, status: 'open' },
      select: { id: true, severity: true, reason: true },
    });
    if (openDrifts.length > 0) {
      return NextResponse.json(
        {
          error: {
            code: 'DRIFT_UNRESOLVED',
            message: `Cannot complete task: ${openDrifts.length} open drift alert(s). Resolve all drift alerts before completing.`,
            details: { drifts: openDrifts },
          },
        },
        { status: 409 },
      );
    }

    // R-181: declarative verification-rule gate. The agent completion path
    // (runs/[runId]/route.ts:291) runs this for EVERY completion, but the
    // human path historically skipped it — so an owner-configured HARD gate
    // (`require_pr_merged`, `require_files_changed`, ...) was enforced for
    // agents yet trivially bypassed by a human clicking "complete". We now
    // mirror the agent path's 422 envelope (R-184 contract: `gate: 'rule'`).
    //
    // The context is built from what the human endpoint actually carries:
    //   - outputSummary   ← completionNote
    //   - deliverablesMet ← the task's plan-deliverable refs (or the note)
    //   - prUrl           ← effectivePrUrl (PR attached now, or the stored one)
    // The endpoint does NOT carry `filesChanged` / `branchName`, so
    // `require_files_changed` / `require_commits_on_branch` fail closed here BY
    // DESIGN: those rules demand evidence a manual completion cannot supply, so
    // a project mandating them must complete such work through the
    // git-integrated agent flow rather than a manual mark-done. Projects with
    // no rules configured pay nothing — `evaluateProjectVerificationRules`
    // returns an empty result and this block is a no-op.
    const humanDeliverablesMet =
      task.planDeliverableRefs.length > 0 ? task.planDeliverableRefs : [body.completionNote];
    const ruleResult = await evaluateProjectVerificationRules(params.projectId, {
      task: {
        id: task.id,
        type: task.type,
        prUrl: effectivePrUrl,
        planDeliverableRefs: task.planDeliverableRefs ?? [],
      },
      body: {
        outputSummary: body.completionNote,
        filesChanged: [],
        deliverablesMet: humanDeliverablesMet,
      },
      // No run scope: the human run is created only AFTER the gate passes, so
      // `require_pr_merged` uses the unscoped legacy PR-merge binding (the same
      // path R-192's `deriveTaskCompletionState` takes for human evidence).
    });
    if (ruleResult.failed.length > 0) {
      return NextResponse.json(
        {
          error: {
            code: 'VERIFICATION_RULE_FAILED',
            message:
              `Cannot complete: ${ruleResult.failed.length} verification rule(s) failed. ` +
              `Owner can edit rules under project settings.`,
            gate: 'rule',
            details: {
              failedRules: ruleResult.failed.map((r) => ({
                ruleId: r.ruleId,
                kind: r.kind,
                message: r.message,
              })),
            },
          },
        },
        { status: 422 },
      );
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
          deliverablesMet: humanDeliverablesMet,
          filesChanged: [],
          blockers: [],
          driftSignals: [],
          lastHeartbeatAt: new Date(),
          endedAt: new Date(),
        },
      });

      // Mark task done and optionally update prUrl. First-time human
      // self-complete is intentionally NOT R-192-gated (see the guard above
      // and issue-1476-complete-human-r192-bypass.test.ts): a human manual
      // completion is its own attestation, unlike an agent's self-report.
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

    eventBus.publish(params.projectId, 'task_completed', {
      taskId: params.taskId,
      title: task.title,
      completedBy: auth.userName,
    });

    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    return handleApiError(error);
  }
}

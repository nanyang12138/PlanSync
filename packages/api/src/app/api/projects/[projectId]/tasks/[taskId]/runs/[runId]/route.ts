import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { completeExecutionRunSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { aiClient } from '@/lib/ai/client';
import {
  COMPLETION_VERIFY_SYSTEM,
  buildCompletionVerifyUser,
} from '@/lib/ai/prompts/completion-verify.prompt';

type Params = { params: { projectId: string; taskId: string; runId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const auth = await authenticate(req);
    const memberAuth = await requireProjectRole(auth, params.projectId);

    const run = await prisma.executionRun.findUnique({
      where: { id: params.runId },
      include: { task: true },
    });
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, 'ExecutionRun not found');
    if (run.taskId !== params.taskId || run.task.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'ExecutionRun not found');
    }

    // R-009: Only the executor, owner of the project, or an exec-scoped key
    // bound to this specific run may heartbeat / complete the run.
    // Without this check, any project developer could hijack another user's run.
    // Runs before the drift-v2 version gate so unauthorized callers can't
    // probe RUN_STALE_VERSION as an oracle for who's running what.
    const isOwner = memberAuth.projectRole === 'owner';
    const isExecutor = memberAuth.userName === run.executorName;
    const isScoped = memberAuth.execRunId === params.runId;
    if (!isOwner && !isExecutor && !isScoped) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Only the executor or project owner can update this run',
      );
    }

    // Drift v2 gate (R-003 + R-006): a run is "stale" if its bound plan version
    // diverges from the task's current bound plan version. This catches every
    // path that can desync them:
    //   - owner manually rebinds the task while a run is in flight
    //   - drift_resolve action='rebind' bumps task.boundPlanVersion
    //   - (future) plan activate auto-pauses runs; a missed pause-ack would
    //     still be caught here even if the SSE notification dropped
    // The check sits at the top of both heartbeat and complete so the API is
    // *the* single source of truth — it does not depend on the agent reading
    // a drift hint in a heartbeat response and stopping voluntarily.
    //
    // Distinct from the open-drift gate: `no_impact` resolves the alert but
    // does not realign versions, so a v1-bound run cannot sneak past complete
    // in the v2 era just because the user clicked "no_impact".
    const taskBound = run.task.boundPlanVersion;
    const runBound = run.boundPlanVersion;
    const versionsAligned = runBound === taskBound;

    if (action === 'heartbeat') {
      if (run.status === 'paused') {
        // Specific code for the MCP/CLI layer: agent should abort the current
        // ai-loop turn and (optionally) call ack_pause with a progress note.
        // Distinct from RUN_STALE_VERSION because the run row itself has been
        // actively moved into a non-running state by the system (vs the task
        // bound version having shifted).
        throw new AppError(
          ErrorCode.STATE_CONFLICT,
          'Run paused: a newer plan version superseded this run. Abort and ack-pause.',
          { code: 'RUN_PAUSED', runStatus: 'paused' },
        );
      }
      if (run.status !== 'running') {
        throw new AppError(
          ErrorCode.STATE_CONFLICT,
          `Execution is ${run.status}. Restart with latest task pack.`,
          { runStatus: run.status },
        );
      }
      if (!versionsAligned) {
        throw new AppError(
          ErrorCode.STATE_CONFLICT,
          `Run bound to plan v${runBound}, task now v${taskBound}. Run is stale.`,
          {
            code: 'RUN_STALE_VERSION',
            runBoundPlanVersion: runBound,
            taskBoundPlanVersion: taskBound,
          },
        );
      }

      // Conditional UPDATE: even though the soft check above passed, the row
      // could have moved (status->superseded by a parallel pause, or a parallel
      // rebind) in the gap between SELECT and UPDATE. Treat count===0 as race
      // loss and return 409 instead of silently bumping lastHeartbeatAt on a
      // row that's no longer eligible.
      const updateResult = await prisma.executionRun.updateMany({
        where: { id: params.runId, status: 'running', boundPlanVersion: taskBound },
        data: { lastHeartbeatAt: new Date() },
      });
      if (updateResult.count === 0) {
        throw new AppError(
          ErrorCode.STATE_CONFLICT,
          'Run state changed concurrently; refetch task pack and decide whether to retry.',
          { code: 'RUN_RACE_LOST' },
        );
      }
      const [updated, driftAlerts] = await Promise.all([
        prisma.executionRun.findUnique({ where: { id: params.runId } }),
        prisma.driftAlert.findMany({
          where: { taskId: params.taskId, status: 'open' },
          select: { id: true, severity: true, reason: true },
        }),
      ]);
      return NextResponse.json({ data: { ...updated, driftAlerts } });
    }

    if (action === 'complete') {
      if (run.status === 'paused') {
        throw new AppError(
          ErrorCode.STATE_CONFLICT,
          'Cannot complete a paused run. Abort and start a fresh execution after drift is resolved.',
          { code: 'RUN_PAUSED', runStatus: 'paused' },
        );
      }
      if (run.status !== 'running') {
        throw new AppError(
          ErrorCode.STATE_CONFLICT,
          `Execution is ${run.status}. Restart with latest task pack.`,
          { runStatus: run.status },
        );
      }
      if (!versionsAligned) {
        throw new AppError(
          ErrorCode.STATE_CONFLICT,
          `Run bound to plan v${runBound}, task now v${taskBound}. Run is stale; cannot complete.`,
          {
            code: 'RUN_STALE_VERSION',
            runBoundPlanVersion: runBound,
            taskBoundPlanVersion: taskBound,
          },
        );
      }

      const openDrifts = await prisma.driftAlert.findMany({
        where: { taskId: params.taskId, status: 'open' },
        select: { id: true, severity: true, reason: true },
      });
      if (openDrifts.length > 0) {
        return NextResponse.json(
          {
            error: {
              code: 'DRIFT_UNRESOLVED',
              message: `Cannot complete execution: ${openDrifts.length} open drift alert(s). Resolve all drift alerts before completing.`,
              details: { drifts: openDrifts },
            },
          },
          { status: 409 },
        );
      }

      const body = await validateBody(req, completeExecutionRunSchema);

      if (body.status === 'completed') {
        // Layer 2: deliverablesMet required for all executors
        if (!body.deliverablesMet || body.deliverablesMet.length === 0) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            'deliverablesMet is required when completing a task. List each plan deliverable and confirm it was met.',
          );
        }

        // AI evidence-based verification for agent executors
        if (run.executorType === 'agent') {
          const task = run.task;
          // R-143: persist every verification outcome (pass, fail, AI
          // unavailable, AI error) so the owner can audit why a 422 fired
          // and which model produced the score. The fields are written
          // *before* we either return 422 or fall through to finalize —
          // a 422 short-circuits the finalize updateMany below, so we
          // can't fold these writes into that single UPDATE.
          const aiVerifyModel = aiClient.modelName;
          try {
            const raw = await aiClient.complete(
              COMPLETION_VERIFY_SYSTEM,
              buildCompletionVerifyUser(body.deliverablesMet, {
                taskTitle: task.title,
                taskType: task.type,
                taskDescription: task.description,
                expectedOutput: task.expectedOutput,
                planDeliverableRefs: task.planDeliverableRefs,
                filesChanged: body.filesChanged,
                outputSummary: body.outputSummary,
              }),
              { purpose: 'completion_verify' },
            );
            if (raw) {
              const result = JSON.parse(raw) as {
                verified: boolean;
                score: number;
                breakdown?: { specificity: number; coherence: number; coverage: number };
                gaps: string[];
                feedback: string;
              };
              await prisma.executionRun.update({
                where: { id: params.runId },
                data: {
                  aiVerifyScore: result.score,
                  aiVerifyBreakdown: result.breakdown ?? Prisma.DbNull,
                  aiVerifyFeedback: result.feedback,
                  aiVerifyModel,
                },
              });
              if (!result.verified || result.score < 75) {
                return NextResponse.json(
                  {
                    error: {
                      code: 'COMPLETION_VERIFICATION_FAILED',
                      message: result.feedback,
                      details: {
                        runId: params.runId,
                        score: result.score,
                        breakdown: result.breakdown,
                        gaps: result.gaps,
                        feedback: result.feedback,
                        model: aiVerifyModel,
                      },
                    },
                  },
                  { status: 422 },
                );
              }
            } else {
              // raw === null: AI unavailable (no provider configured or
              // the call returned no result after retries). Record the
              // "allowed through" decision so the owner sees explicitly
              // that the gate was a no-op, not a silent pass.
              await prisma.executionRun.update({
                where: { id: params.runId },
                data: {
                  aiVerifyScore: null,
                  aiVerifyBreakdown: Prisma.DbNull,
                  aiVerifyFeedback: 'AI unavailable, allowed through',
                  aiVerifyModel,
                },
              });
            }
          } catch (err) {
            // AI error: allow through, don't block on infra failure. Still
            // surface the failure on the run row so the owner can tell
            // "AI said pass" apart from "AI exploded mid-call".
            const errMessage = err instanceof Error ? err.message : String(err);
            console.warn(
              `[completion-verify] AI verification failed for task ${params.taskId}, run ${params.runId} — allowing through:`,
              errMessage,
            );
            await prisma.executionRun
              .update({
                where: { id: params.runId },
                data: {
                  aiVerifyScore: null,
                  aiVerifyBreakdown: Prisma.DbNull,
                  aiVerifyFeedback: `AI error, allowed through: ${errMessage}`,
                  aiVerifyModel,
                },
              })
              .catch(() => {
                // Best-effort audit write; never let the audit failure
                // mask the original AI error or block the completion.
              });
          }
        }
      }

      const { deliverablesMet, ...bodyWithoutDeliverablesMet } = body;
      // Atomic finalize: even after all the soft checks above, the run row could
      // have been touched between SELECT and UPDATE (e.g. owner force-supersede,
      // future plan-activate pause). Re-assert status='running' and version
      // alignment in the WHERE — if count===0 we lost the race, surface as 409
      // rather than silently writing into a row that's no longer ours.
      const finalizeResult = await prisma.executionRun.updateMany({
        where: { id: params.runId, status: 'running', boundPlanVersion: taskBound },
        data: {
          ...bodyWithoutDeliverablesMet,
          endedAt: new Date(),
        },
      });
      if (finalizeResult.count === 0) {
        throw new AppError(
          ErrorCode.STATE_CONFLICT,
          'Run state changed concurrently; cannot complete. Refetch task pack and decide whether to retry.',
          { code: 'RUN_RACE_LOST' },
        );
      }
      const updated = await prisma.executionRun.findUnique({ where: { id: params.runId } });
      // Persist deliverablesMet via raw SQL to avoid Prisma client version mismatch
      // (the Prisma client binary may be older than the schema; raw SQL bypasses client validation)
      if (deliverablesMet && deliverablesMet.length > 0) {
        await prisma.$executeRaw`
          UPDATE execution_runs
          SET deliverables_met = ${deliverablesMet}
          WHERE id = ${params.runId}
        `;
      }

      if (body.status === 'completed') {
        await prisma.task.update({
          where: { id: params.taskId },
          data: {
            status: 'done',
            ...(body.branchName ? { branchName: body.branchName } : {}),
          },
        });
      } else if (body.status === 'failed') {
        const otherRunning = await prisma.executionRun.count({
          where: { taskId: params.taskId, status: 'running', id: { not: params.runId } },
        });
        if (otherRunning === 0) {
          await prisma.task.update({
            where: { id: params.taskId },
            data: { status: 'blocked' },
          });
        }
      }

      const activityType = body.status === 'completed' ? 'execution_completed' : 'execution_failed';
      await createActivity({
        projectId: params.projectId,
        type: activityType,
        actorName: run.executorName,
        actorType: run.executorType as 'human' | 'agent',
        summary: `Execution ${body.status} for task`,
        metadata: { runId: run.id, taskId: params.taskId },
      });

      if (body.status === 'completed') {
        eventBus.publish(params.projectId, 'task_completed', {
          taskId: params.taskId,
          title: run.task.title,
          completedBy: run.executorName,
          summary: body.outputSummary || '',
          filesChanged: body.filesChanged || [],
        });
        dispatchWebhooks(params.projectId, 'task_completed', {
          taskId: params.taskId,
          title: run.task.title,
          completedBy: run.executorName,
          summary: body.outputSummary || '',
          filesChanged: body.filesChanged || [],
        });
      }

      return NextResponse.json({ data: updated });
    }

    throw new AppError(ErrorCode.BAD_REQUEST, 'Action must be "heartbeat" or "complete"');
  } catch (error) {
    return handleApiError(error);
  }
}

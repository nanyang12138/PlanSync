import { NextRequest, NextResponse } from 'next/server';
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
    await requireProjectRole(auth, params.projectId);

    const run = await prisma.executionRun.findUnique({
      where: { id: params.runId },
      include: { task: true },
    });
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, 'ExecutionRun not found');
    if (run.taskId !== params.taskId || run.task.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'ExecutionRun not found');
    }

    if (action === 'heartbeat') {
      if (run.status !== 'running') {
        throw new AppError(ErrorCode.STATE_CONFLICT, 'Can only heartbeat running executions');
      }
      const updated = await prisma.executionRun.update({
        where: { id: params.runId },
        data: { lastHeartbeatAt: new Date() },
      });
      return NextResponse.json({ data: updated });
    }

    if (action === 'complete') {
      if (run.status !== 'running') {
        throw new AppError(ErrorCode.STATE_CONFLICT, 'Can only complete running executions');
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

        // Layer 3: AI verification for agent executors only
        if (run.executorType === 'agent') {
          const task = run.task;
          const plan = await prisma.plan.findFirst({
            where: { projectId: params.projectId, version: task.boundPlanVersion },
          });
          const planDeliverables =
            task.planDeliverableRefs && task.planDeliverableRefs.length > 0
              ? task.planDeliverableRefs
              : (plan?.deliverables ?? []);

          if (!plan) {
            console.warn(
              `[completion-verify] Plan v${task.boundPlanVersion} not found for task ${params.taskId} — skipping AI verification`,
            );
          }

          if (planDeliverables.length > 0) {
            try {
              const raw = await aiClient.complete(
                COMPLETION_VERIFY_SYSTEM,
                buildCompletionVerifyUser(
                  body.deliverablesMet,
                  task.title,
                  planDeliverables,
                  task.expectedOutput,
                ),
              );
              if (raw) {
                const result = JSON.parse(raw) as {
                  verified: boolean;
                  score: number;
                  gaps: string[];
                  feedback: string;
                };
                if (!result.verified || result.score < 75) {
                  return NextResponse.json(
                    {
                      error: 'COMPLETION_VERIFICATION_FAILED',
                      message: 'deliverablesMet does not cover all plan deliverables.',
                      gaps: result.gaps,
                      feedback: result.feedback,
                      score: result.score,
                    },
                    { status: 422 },
                  );
                }
              }
              // raw === null: AI unavailable, allow through
            } catch (err) {
              // AI error: allow through, don't block on infra failure
              console.warn(
                `[completion-verify] AI verification failed for task ${params.taskId}, run ${params.runId} — allowing through:`,
                err instanceof Error ? err.message : err,
              );
            }
          }
        }
      }

      const { deliverablesMet, ...bodyWithoutDeliverablesMet } = body;
      const updated = await prisma.executionRun.update({
        where: { id: params.runId },
        data: {
          ...bodyWithoutDeliverablesMet,
          endedAt: new Date(),
        },
      });
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

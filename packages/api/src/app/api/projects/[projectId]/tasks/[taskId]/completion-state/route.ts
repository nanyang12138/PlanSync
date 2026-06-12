import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { auditCrossProjectTaskIfNeeded } from '@/lib/task-scope';
import {
  deriveTaskCompletionState,
  type TaskCompletionMissingCode,
} from '@/lib/task-state-machine';

type Params = { params: Promise<{ projectId: string; taskId: string }> };

/**
 * R-210: read-only "why is this task still awaiting_evidence?" explainer.
 *
 * This is the DISPLAY sibling of the R-192 completion gate, not a gate
 * itself. It NEVER mutates a row and NEVER returns 409/422 — it just
 * re-runs the pure `deriveTaskCompletionState` helper and surfaces the
 * result, plus two project/task counts, so CI / a PR-body block / the
 * Web UI can show an operator exactly what evidence is missing without
 * attempting (and being rejected by) a real `complete`.
 *
 * Response shape (`data`):
 *   - taskStatus           the task's CURRENT persisted status (todo /
 *                          in_progress / awaiting_evidence / done / ...).
 *   - gateApplied          whether the R-192 evidence gate evaluates this
 *                          task at all (false = no git wiring → the gate
 *                          would let it flip straight to done).
 *   - status               the status the gate WOULD derive right now
 *                          ('done' | 'awaiting_evidence'). Mirrors what a
 *                          `complete` call would resolve to.
 *   - missing              authoritative list of missing-signal records
 *                          ({ code, message, details }) — the source of
 *                          truth for "why".
 *   - driftOpen            an open drift alert blocks completion (queried
 *                          directly so it is always accurate, even when the
 *                          gate short-circuits on it).
 *   - prMerged             tri-state convenience flag (see below).
 *   - deliverableEvidence  tri-state convenience flag (see below).
 *   - outboxDeadLetters    count of dead-lettered domain_events in this
 *                          project (R-208). When > 0 the evidence pipeline
 *                          itself is broken, so missing pr_merged /
 *                          deliverable_evidence may NEVER arrive on their
 *                          own — an operator signal, not a task signal.
 *
 * `prMerged` / `deliverableEvidence` are `boolean | null`. They are only
 * MEANINGFUL when the gate applied AND it did not short-circuit on drift —
 * otherwise the underlying check never ran, so reporting `true`/`false`
 * would be a lie. In those cases they are `null` ("not evaluated"). When
 * meaningful, `true` means "no such signal is missing" (satisfied, or not
 * required for this task) and `false` means the signal is in `missing`.
 */
export async function GET(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    // R-135: scope by projectId so a member of project A cannot read the
    // completion state of a task in project B by guessing its id.
    const task = await prisma.task.findFirst({
      where: { id: params.taskId, projectId: params.projectId },
      select: {
        id: true,
        status: true,
        prUrl: true,
        planDeliverableRefs: true,
        boundPlanVersion: true,
      },
    });
    if (!task) {
      await auditCrossProjectTaskIfNeeded(
        params.taskId,
        params.projectId,
        'GET /tasks/:id/completion-state',
      );
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }

    // Pure derivation — no write. Same call the complete paths make.
    const derived = await deriveTaskCompletionState({
      projectId: params.projectId,
      task: {
        id: task.id,
        prUrl: task.prUrl,
        planDeliverableRefs: task.planDeliverableRefs ?? [],
        boundPlanVersion: task.boundPlanVersion,
      },
    });

    // Drift is queried directly rather than inferred from `missing`: the
    // gate returns ONLY drift_open when it short-circuits on it (stage 0),
    // so a direct count is the accurate source for display in every branch.
    const openDriftCount = await prisma.driftAlert.count({
      where: { taskId: task.id, status: 'open' },
    });
    const driftOpen = openDriftCount > 0;

    // R-208 dead-letter visibility: a broken evidence pipeline means the
    // pr_merged / deliverable_evidence signals may never land. Project-scoped.
    const outboxDeadLetters = await prisma.domainEvent.count({
      where: { projectId: params.projectId, failedAt: { not: null } },
    });

    const hasMissing = (code: TaskCompletionMissingCode) =>
      derived.missing.some((m) => m.code === code);

    // prMerged / deliverableEvidence are only meaningful when the gate ran
    // AND did not short-circuit on drift (which leaves the other checks
    // un-evaluated). Otherwise: null = "not evaluated this pass".
    const checksEvaluated = derived.gateApplied && !driftOpen;
    const prMerged = checksEvaluated ? !hasMissing('pr_merged') : null;
    const deliverableEvidence = checksEvaluated ? !hasMissing('deliverable_evidence') : null;

    return NextResponse.json({
      data: {
        taskId: task.id,
        taskStatus: task.status,
        gateApplied: derived.gateApplied,
        status: derived.status,
        missing: derived.missing,
        driftOpen,
        prMerged,
        deliverableEvidence,
        outboxDeadLetters,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

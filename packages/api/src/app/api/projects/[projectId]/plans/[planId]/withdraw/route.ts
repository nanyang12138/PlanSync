import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { requirePlanInProject } from '@/lib/plan-scope';

type Params = { params: Promise<{ projectId: string; planId: string }> };

/**
 * R-205: withdraw a `proposed` plan back to `draft`.
 *
 * Closes the dead-end identified in the plan-state-machine review:
 *
 *   1. propose accepted zero reviewers (R-205 now auto-adds owner, but legacy
 *      plans may still have empty review lists)
 *   2. activate refused to flip a proposed-with-zero-reviewers plan unless
 *      ?force=true was passed
 *   3. there was no MCP-visible way to add reviewers to an already-proposed
 *      plan, nor to roll it back to draft
 *
 * The result was a stuck `proposed` row that had no MCP-driven escape hatch.
 * `withdraw` is that escape hatch: owner can return to draft, edit reviewers
 * (or any other field), and re-propose. PlanReview rows for the proposal are
 * deleted on withdraw — they belong to the proposal cycle, not to the draft.
 *
 * Idempotency: a plan that is already a draft 409s rather than silently
 * succeeding, so callers see the state-machine boundary clearly.
 */
export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');

    const plan = await requirePlanInProject(params.planId, params.projectId);
    if (plan.status !== 'proposed') {
      throw new AppError(
        ErrorCode.STATE_CONFLICT,
        `Only proposed plans can be withdrawn (current status: ${plan.status}). ` +
          'If the plan is already active or superseded, use plansync_plan_reactivate or create a new draft.',
      );
    }

    // Closes #816: the previous version read the plan's status with
    // requirePlanInProject (OUTSIDE any transaction), then unconditionally
    // ran `tx.plan.update({ where: { id } })` inside the transaction.
    // A concurrent activate (or another withdraw) that flipped the plan's
    // state between the check and the update used to be silently
    // overwritten — e.g. a freshly-activated plan could be reverted to
    // `draft` and its PlanReview rows deleted. Use updateMany scoped to
    // `status: 'proposed'` so the row only updates when it's still in
    // the same state we observed; on count===0 we abort with
    // STATE_CONFLICT instead of corrupting state.
    const withdrawn = await prisma.$transaction(async (tx) => {
      const result = await tx.plan.updateMany({
        where: { id: params.planId, status: 'proposed' },
        data: { status: 'draft' },
      });
      if (result.count === 0) {
        // Race lost: another writer changed the status between our
        // read above and this update. Re-read to give the caller an
        // actionable status instead of a generic conflict.
        const fresh = await tx.plan.findUnique({
          where: { id: params.planId },
          select: { status: true },
        });
        throw new AppError(
          ErrorCode.STATE_CONFLICT,
          `Concurrent state change: plan is no longer 'proposed' (now '${fresh?.status ?? 'unknown'}'). ` +
            'Re-read the plan and decide whether to withdraw it again or take a different action.',
        );
      }
      // Only after a successful status flip do we drop the PlanReview
      // rows. If we did this first and then the updateMany lost the
      // race, we'd have already destroyed the proposal cycle's review
      // history without producing the corresponding draft transition.
      await tx.planReview.deleteMany({ where: { planId: params.planId } });

      const fresh = await tx.plan.findUnique({ where: { id: params.planId } });
      if (!fresh) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Plan disappeared after withdraw');
      }
      return fresh;
    });

    await createActivity({
      projectId: params.projectId,
      type: 'plan_withdrawn',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Plan v${withdrawn.version} "${withdrawn.title}" withdrawn back to draft`,
      metadata: {
        planId: withdrawn.id,
        version: withdrawn.version,
      },
    });

    eventBus.publish(params.projectId, 'plan_withdrawn', {
      planId: withdrawn.id,
      version: withdrawn.version,
      title: withdrawn.title,
      withdrawnBy: auth.userName,
    });

    return NextResponse.json({ data: withdrawn });
  } catch (error) {
    return handleApiError(error);
  }
}

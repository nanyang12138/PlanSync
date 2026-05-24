import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { requirePlanInProject } from '@/lib/plan-scope';

type Params = { params: { projectId: string; planId: string } };

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
export async function POST(req: NextRequest, { params }: Params) {
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

    const withdrawn = await prisma.$transaction(async (tx) => {
      // PlanReview rows are scoped to the current proposal cycle. Drop them
      // so the next propose call starts with a clean review slate; otherwise
      // stale "approved" rows would survive a full edit-and-re-propose loop
      // and silently let an updated plan inherit prior approvals.
      await tx.planReview.deleteMany({ where: { planId: plan.id } });

      return tx.plan.update({
        where: { id: params.planId },
        data: { status: 'draft' },
      });
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

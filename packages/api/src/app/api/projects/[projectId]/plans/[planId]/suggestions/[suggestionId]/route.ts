import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { resolveSuggestionSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { writeBoth, syncDeliverableArrayMirror, type SplitField } from '@/lib/plan-items';

const SPLIT_FIELDS = new Set<SplitField>(['constraints', 'standards', 'deliverables']);

type Params = { params: Promise<{ projectId: string; planId: string; suggestionId: string }> };

type SuggestionTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function applySuggestion(
  tx: SuggestionTx,
  planId: string,
  suggestion: { field: string; action: string; value: string; deliverableId: string | null },
): Promise<boolean> {
  const plan = await tx.plan.findUnique({ where: { id: planId } });
  if (!plan) return false;

  const arrayFields = ['constraints', 'standards', 'deliverables', 'openQuestions'] as const;
  const stringFields = ['goal', 'scope'] as const;

  // R-155 follow-up (issue #1146): when the suggestion is scoped to a
  // specific PlanDeliverable row, route the accept through the split
  // table instead of munging the legacy `plan.deliverables` String[].
  // Without this branch the deliverableId was silently dropped on accept
  // and we'd fall back to `array.filter(v !== value)` / `[...arr, value]`,
  // which left the targeted row untouched — directly the contract break
  // reported in the cursor-review finding (fingerprint dd28352640c8).
  if (suggestion.deliverableId && suggestion.field === 'deliverables') {
    return applyDeliverableScopedSuggestion(tx, planId, {
      action: suggestion.action,
      value: suggestion.value,
      deliverableId: suggestion.deliverableId,
    });
  }

  if (
    suggestion.action === 'set' &&
    stringFields.includes(suggestion.field as (typeof stringFields)[number])
  ) {
    await tx.plan.update({
      where: { id: planId },
      data: { [suggestion.field]: suggestion.value },
    });

    await tx.planSuggestion.updateMany({
      where: {
        planId,
        field: suggestion.field,
        action: 'set',
        status: 'pending',
      },
      data: { status: 'conflict' },
    });
    return true;
  } else if (
    suggestion.action === 'append' &&
    arrayFields.includes(suggestion.field as (typeof arrayFields)[number])
  ) {
    const currentArr = (plan as Record<string, unknown>)[suggestion.field] as string[];
    const next = [...currentArr, suggestion.value];
    await applyArrayWrite(tx, planId, suggestion.field, next);
    return true;
  } else if (
    suggestion.action === 'remove' &&
    arrayFields.includes(suggestion.field as (typeof arrayFields)[number])
  ) {
    const currentArr = (plan as Record<string, unknown>)[suggestion.field] as string[];
    const next = currentArr.filter((v) => v !== suggestion.value);
    await applyArrayWrite(tx, planId, suggestion.field, next);
    return true;
  }

  return false;
}

/**
 * Per-row apply path for suggestions that carry `deliverableId`.
 *
 * Mapping rationale — the existing `(field, action, value)` shape does
 * not carry which property to mutate, so we pick the cleanest natural
 * semantics that the legacy whole-array path was *trying* to express:
 *
 *   - action='remove': mark the targeted row as `status='deprecated'`.
 *     Preserves row identity (so the supersede chain in R-152, the
 *     TaskDeliverableLink rows in R-153, and the CommitDeliverableLink
 *     rows in R-191 are all kept intact), unlike the old path which
 *     re-wrote the legacy array and let writeBoth wipe+recreate every
 *     PlanDeliverable row.
 *
 *   - action='append': overwrite the targeted row's `body` with `value`.
 *     Append semantics on a single row are ambiguous; the closest match
 *     to "agent has new content for this deliverable" (the use-case
 *     called out in the deliverableId comment) is to treat `value` as
 *     the new body. Title / refUri / status need richer per-row mutation
 *     than (field, action, value) can carry — those continue to go
 *     through `plansync_deliverable_update` directly.
 *
 *   - any other action is rejected (returns false → BAD_REQUEST upstream),
 *     so a stale or malformed suggestion does not silently no-op.
 *
 * In both supported branches we re-derive the legacy `plan.deliverables`
 * String[] mirror via `syncDeliverableArrayMirror` so plan_show / drift /
 * CLI banner readers (which still read the legacy array) observe a
 * consistent view after accept commits.
 */
async function applyDeliverableScopedSuggestion(
  tx: SuggestionTx,
  planId: string,
  suggestion: { action: string; value: string; deliverableId: string },
): Promise<boolean> {
  // Re-check the deliverable still belongs to this plan inside the
  // transaction — between the create-time validation (suggestions/route.ts)
  // and accept-time the owner could have rebound the suggestion's plan or
  // deleted the deliverable; SetNull on PlanSuggestion.deliverableId means
  // a deleted row would already null this out, so a missing match here is
  // a real "row was moved out" race rather than a permissions probe.
  const deliverable = await tx.planDeliverable.findUnique({
    where: { id: suggestion.deliverableId },
    select: { id: true, planId: true },
  });
  if (!deliverable || deliverable.planId !== planId) {
    return false;
  }

  if (suggestion.action === 'remove') {
    await tx.planDeliverable.update({
      where: { id: deliverable.id },
      data: { status: 'deprecated' },
    });
    await syncDeliverableArrayMirror(planId, tx);
    return true;
  }

  if (suggestion.action === 'append') {
    await tx.planDeliverable.update({
      where: { id: deliverable.id },
      data: { body: suggestion.value },
    });
    await syncDeliverableArrayMirror(planId, tx);
    return true;
  }

  return false;
}

// R-152: route array-field suggestion writes through writeBoth so the
// split tables stay in lockstep. openQuestions has no split table, so it
// keeps the direct plan.update path (same logic as the append route).
async function applyArrayWrite(
  tx: SuggestionTx,
  planId: string,
  field: string,
  next: string[],
): Promise<void> {
  if (SPLIT_FIELDS.has(field as SplitField)) {
    await writeBoth(planId, { [field as SplitField]: next }, tx);
    return;
  }
  await tx.plan.update({
    where: { id: planId },
    data: { [field]: next },
  });
}

export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, resolveSuggestionSchema);

    const suggestion = await prisma.planSuggestion.findFirst({
      where: {
        id: params.suggestionId,
        planId: params.planId,
        plan: { projectId: params.projectId },
      },
    });
    if (!suggestion) throw new AppError(ErrorCode.NOT_FOUND, 'Suggestion not found');
    if (suggestion.status !== 'pending') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Suggestion already resolved');
    }

    if (action === 'accept') {
      const updated = await prisma.$transaction(async (tx) => {
        const applied = await applySuggestion(tx, params.planId, suggestion);
        if (!applied) {
          throw new AppError(
            ErrorCode.BAD_REQUEST,
            `Invalid field/action combination: ${suggestion.action} on "${suggestion.field}"`,
          );
        }
        return tx.planSuggestion.update({
          where: { id: params.suggestionId },
          data: {
            status: 'accepted',
            resolvedBy: auth.userName,
            resolvedComment: body.comment,
            resolvedAt: new Date(),
          },
        });
      });

      await createActivity({
        projectId: params.projectId,
        type: 'suggestion_accepted',
        actorName: auth.userName,
        actorType: 'human',
        summary: `Suggestion accepted: ${suggestion.action} "${suggestion.field}"`,
        metadata: { suggestionId: suggestion.id },
      });

      eventBus.publish(params.projectId, 'suggestion_resolved', {
        suggestionId: suggestion.id,
        status: 'accepted',
        resolvedBy: auth.userName,
      });
      dispatchWebhooks(params.projectId, 'suggestion_resolved', {
        suggestionId: suggestion.id,
        status: 'accepted',
        resolvedBy: auth.userName,
      });

      return NextResponse.json({ data: updated });
    }

    if (action === 'reject') {
      const updated = await prisma.planSuggestion.update({
        where: { id: params.suggestionId },
        data: {
          status: 'rejected',
          resolvedBy: auth.userName,
          resolvedComment: body.comment,
          resolvedAt: new Date(),
        },
      });

      await createActivity({
        projectId: params.projectId,
        type: 'suggestion_rejected',
        actorName: auth.userName,
        actorType: 'human',
        summary: `Suggestion rejected: ${suggestion.action} "${suggestion.field}"`,
        metadata: { suggestionId: suggestion.id },
      });

      eventBus.publish(params.projectId, 'suggestion_resolved', {
        suggestionId: suggestion.id,
        status: 'rejected',
        resolvedBy: auth.userName,
      });
      dispatchWebhooks(params.projectId, 'suggestion_resolved', {
        suggestionId: suggestion.id,
        status: 'rejected',
        resolvedBy: auth.userName,
      });

      return NextResponse.json({ data: updated });
    }

    throw new AppError(ErrorCode.BAD_REQUEST, 'Action must be "accept" or "reject"');
  } catch (error) {
    return handleApiError(error);
  }
}

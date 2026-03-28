import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { resolveSuggestionSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';

type Params = { params: { projectId: string; planId: string; suggestionId: string } };

async function applySuggestion(
  planId: string,
  suggestion: { field: string; action: string; value: string },
): Promise<boolean> {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) return false;

  const arrayFields = ['constraints', 'standards', 'deliverables', 'openQuestions'] as const;
  const stringFields = ['goal', 'scope'] as const;

  if (
    suggestion.action === 'set' &&
    stringFields.includes(suggestion.field as (typeof stringFields)[number])
  ) {
    await prisma.plan.update({
      where: { id: planId },
      data: { [suggestion.field]: suggestion.value },
    });

    await prisma.planSuggestion.updateMany({
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
    await prisma.plan.update({
      where: { id: planId },
      data: { [suggestion.field]: [...currentArr, suggestion.value] },
    });
    return true;
  } else if (
    suggestion.action === 'remove' &&
    arrayFields.includes(suggestion.field as (typeof arrayFields)[number])
  ) {
    const currentArr = (plan as Record<string, unknown>)[suggestion.field] as string[];
    await prisma.plan.update({
      where: { id: planId },
      data: { [suggestion.field]: currentArr.filter((v) => v !== suggestion.value) },
    });
    return true;
  }

  return false;
}

export async function POST(req: NextRequest, { params }: Params) {
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
      const applied = await applySuggestion(params.planId, suggestion);
      if (!applied) {
        throw new AppError(
          ErrorCode.BAD_REQUEST,
          `Invalid field/action combination: ${suggestion.action} on "${suggestion.field}"`,
        );
      }
      const updated = await prisma.planSuggestion.update({
        where: { id: params.suggestionId },
        data: {
          status: 'accepted',
          resolvedBy: auth.userName,
          resolvedComment: body.comment,
          resolvedAt: new Date(),
        },
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

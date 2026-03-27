import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { resolveSuggestionSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';

type Params = { params: { projectId: string; planId: string; suggestionId: string } };

async function applySuggestion(planId: string, suggestion: { field: string; action: string; value: string }) {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) return;

  const arrayFields = ['constraints', 'standards', 'deliverables', 'openQuestions'] as const;
  const stringFields = ['goal', 'scope'] as const;

  if (suggestion.action === 'set' && stringFields.includes(suggestion.field as typeof stringFields[number])) {
    await prisma.plan.update({
      where: { id: planId },
      data: { [suggestion.field]: suggestion.value },
    });

    await prisma.planSuggestion.updateMany({
      where: {
        planId,
        id: { not: undefined },
        field: suggestion.field,
        action: 'set',
        status: 'pending',
      },
      data: { status: 'conflict' },
    });
  } else if (suggestion.action === 'append' && arrayFields.includes(suggestion.field as typeof arrayFields[number])) {
    const currentArr = (plan as Record<string, unknown>)[suggestion.field] as string[];
    await prisma.plan.update({
      where: { id: planId },
      data: { [suggestion.field]: [...currentArr, suggestion.value] },
    });
  } else if (suggestion.action === 'remove' && arrayFields.includes(suggestion.field as typeof arrayFields[number])) {
    const currentArr = (plan as Record<string, unknown>)[suggestion.field] as string[];
    await prisma.plan.update({
      where: { id: planId },
      data: { [suggestion.field]: currentArr.filter((v) => v !== suggestion.value) },
    });
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, resolveSuggestionSchema);

    const suggestion = await prisma.planSuggestion.findUnique({ where: { id: params.suggestionId } });
    if (!suggestion) throw new AppError(ErrorCode.NOT_FOUND, 'Suggestion not found');
    if (suggestion.status !== 'pending') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Suggestion already resolved');
    }

    if (action === 'accept') {
      await applySuggestion(params.planId, suggestion);
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

      return NextResponse.json({ data: updated });
    }

    throw new AppError(ErrorCode.BAD_REQUEST, 'Action must be "accept" or "reject"');
  } catch (error) {
    return handleApiError(error);
  }
}

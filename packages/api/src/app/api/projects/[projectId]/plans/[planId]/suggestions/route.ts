import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody, validateSearchParams } from '@/lib/validate';
import { createSuggestionSchema, paginationSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';

type Params = { params: { projectId: string; planId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const { page = 1, pageSize = 20 } = validateSearchParams(req, paginationSchema);
    const skip = (page - 1) * pageSize;

    const [suggestions, total] = await Promise.all([
      prisma.planSuggestion.findMany({
        where: { planId: params.planId },
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.planSuggestion.count({ where: { planId: params.planId } }),
    ]);

    return NextResponse.json({
      data: suggestions,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    const authCtx = await requireProjectRole(auth, params.projectId);
    const body = await validateBody(req, createSuggestionSchema);

    const plan = await prisma.plan.findUnique({ where: { id: params.planId } });
    if (!plan) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    if (plan.status !== 'draft' && plan.status !== 'proposed') {
      throw new AppError(
        ErrorCode.STATE_CONFLICT,
        'Suggestions only accepted on draft or proposed plans',
      );
    }

    const member = await prisma.projectMember.findUnique({
      where: { projectId_name: { projectId: params.projectId, name: auth.userName } },
    });

    const suggestion = await prisma.planSuggestion.create({
      data: {
        ...body,
        planId: params.planId,
        suggestedBy: auth.userName,
        suggestedByType: member?.type === 'agent' ? 'agent' : 'human',
      },
    });

    await createActivity({
      projectId: params.projectId,
      type: 'suggestion_created',
      actorName: auth.userName,
      actorType: member?.type === 'agent' ? 'agent' : 'human',
      summary: `Suggestion: ${body.action} "${body.field}" on Plan v${plan.version}`,
      metadata: { suggestionId: suggestion.id, planId: params.planId },
    });

    eventBus.publish(params.projectId, 'suggestion_created', {
      suggestionId: suggestion.id,
      suggestedBy: auth.userName,
      field: body.field,
      value: body.value,
    });
    dispatchWebhooks(params.projectId, 'suggestion_created', {
      suggestionId: suggestion.id,
      suggestedBy: auth.userName,
      field: body.field,
      value: body.value,
    });

    return NextResponse.json({ data: suggestion }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

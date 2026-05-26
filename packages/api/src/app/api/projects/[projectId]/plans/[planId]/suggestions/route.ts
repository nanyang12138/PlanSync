import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody, validateSearchParams } from '@/lib/validate';
import { createSuggestionSchema, paginationSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { requirePlanInProject } from '@/lib/plan-scope';

type Params = { params: Promise<{ projectId: string; planId: string }> };

export async function GET(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    await requirePlanInProject(params.planId, params.projectId);
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

export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const body = await validateBody(req, createSuggestionSchema);

    const plan = await requirePlanInProject(params.planId, params.projectId);
    if (!['draft', 'proposed', 'active'].includes(plan.status)) {
      throw new AppError(
        ErrorCode.STATE_CONFLICT,
        `Cannot add suggestions to a ${plan.status} plan`,
      );
    }

    // R-155: when the suggestion targets a specific deliverable, verify
    // that row lives on the same plan so callers can't probe arbitrary
    // deliverable ids. NOT_FOUND collapses cross-plan / cross-project
    // probes into the same response (matches `requirePlanInProject`).
    if (body.deliverableId) {
      const linked = await prisma.planDeliverable.findUnique({
        where: { id: body.deliverableId },
        select: { planId: true },
      });
      if (!linked || linked.planId !== params.planId) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Deliverable not found');
      }
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

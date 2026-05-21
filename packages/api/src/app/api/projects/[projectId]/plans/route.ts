import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody, validateSearchParams } from '@/lib/validate';
import { AppError, ErrorCode, createPlanSchema, paginationSchema } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';

type Params = { params: { projectId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const { page = 1, pageSize = 20 } = validateSearchParams(req, paginationSchema);
    const skip = (page - 1) * pageSize;

    const [plans, total] = await Promise.all([
      prisma.plan.findMany({
        where: { projectId: params.projectId },
        skip,
        take: pageSize,
        orderBy: { version: 'desc' },
      }),
      prisma.plan.count({ where: { projectId: params.projectId } }),
    ]);

    return NextResponse.json({
      data: plans,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, createPlanSchema);

    const blocking = await prisma.plan.findFirst({
      where: {
        projectId: params.projectId,
        status: { in: ['draft', 'proposed'] },
      },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, title: true, status: true },
    });
    if (blocking) {
      throw new AppError(
        ErrorCode.STATE_CONFLICT,
        `Cannot create a new plan: v${blocking.version} "${blocking.title}" already exists with status "${blocking.status}". Update, propose, or activate the existing plan first.`,
        {
          blockingPlanId: blocking.id,
          blockingVersion: blocking.version,
          blockingStatus: blocking.status,
        },
      );
    }

    const latestPlan = await prisma.plan.findFirst({
      where: { projectId: params.projectId },
      orderBy: { version: 'desc' },
    });

    const plan = await prisma.plan.create({
      data: {
        ...body,
        projectId: params.projectId,
        version: (latestPlan?.version ?? 0) + 1,
        status: 'draft',
        createdBy: auth.userName,
      },
    });

    await createActivity({
      projectId: params.projectId,
      type: 'plan_created',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Plan v${plan.version} "${plan.title}" created as draft`,
      metadata: { planId: plan.id, version: plan.version },
    });

    eventBus.publish(params.projectId, 'plan_created', {
      planId: plan.id,
      version: plan.version,
      title: plan.title,
      createdBy: auth.userName,
    });

    return NextResponse.json({ data: plan }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

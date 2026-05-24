import { NextRequest, NextResponse } from 'next/server';
import type { Plan } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody, validateSearchParams } from '@/lib/validate';
import { AppError, ErrorCode, createPlanSchema, paginationSchema } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { writeBoth } from '@/lib/plan-items';

function isUniqueViolation(err: unknown): boolean {
  return !!(
    err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: string }).code === 'P2002'
  );
}

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

    // R-050: wrap blocking check + version computation + create into one
    // transaction so concurrent POSTs cannot read the same `latestPlan.version`
    // and race on `@@unique([projectId, version])`. If the unique index still
    // fires (e.g. two transactions raced through `findFirst` before either
    // committed), Prisma raises P2002 — retry the whole transaction once;
    // on retry the blocking check will see the freshly committed draft and
    // surface a clean STATE_CONFLICT to the loser.
    const createPlanTx = () =>
      prisma.$transaction<Plan>(async (tx) => {
        const blocking = await tx.plan.findFirst({
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

        const latestPlan = await tx.plan.findFirst({
          where: { projectId: params.projectId },
          orderBy: { version: 'desc' },
          select: { version: true },
        });

        const created = await tx.plan.create({
          data: {
            ...body,
            projectId: params.projectId,
            version: (latestPlan?.version ?? 0) + 1,
            status: 'draft',
            createdBy: auth.userName,
          },
        });

        // R-152: every plan write must populate the split tables so the
        // String[] columns and PlanDeliverable/PlanConstraint/PlanStandard
        // rows stay 1:1. Drift-engine v3 (R-154) and per-deliverable
        // features depend on the split rows being canonical for any plan
        // touched by current code, including brand-new drafts that haven't
        // been edited yet.
        await writeBoth(
          created.id,
          {
            deliverables: body.deliverables,
            constraints: body.constraints,
            standards: body.standards,
          },
          tx,
        );

        return created;
      });

    let plan: Plan;
    try {
      plan = await createPlanTx();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      plan = await createPlanTx();
    }

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

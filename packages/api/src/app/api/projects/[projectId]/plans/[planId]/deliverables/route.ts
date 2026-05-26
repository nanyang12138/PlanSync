import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { AppError, ErrorCode, createDeliverableSchema } from '@plansync/shared';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { createActivity } from '@/lib/activity';
import { requirePlanInProject } from '@/lib/plan-scope';
import { syncDeliverableArrayMirror } from '@/lib/plan-items';

// R-155: per-deliverable CRUD surface. Each route enforces:
//   - authenticate + requireProjectRole (read = any member, write = owner).
//   - requireNotExecScoped on writes so exec-scoped Genie sessions cannot
//     bypass MCP and rewrite the plan via raw curl (matches the rest of the
//     plan write paths — same rule as plan PATCH / append / propose).
//   - the plan must be in `draft` for create/update because rewriting an
//     active plan's deliverable rows would leak into drift-engine and
//     diff-against-previous-version logic. Owners who need to change an
//     active plan must propose a new version (existing flow).
//
// `supersede` (R-152's helper, called automatically on activate) is also
// exposed as an explicit per-row action under `/deliverables/:id/supersede`
// for the rare cases where an owner wants to retire one item without
// bumping a plan version.

type Params = { params: Promise<{ projectId: string; planId: string }> };

export async function GET(_req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(_req);
    await requireProjectRole(auth, params.projectId);
    await requirePlanInProject(params.planId, params.projectId);

    const rows = await prisma.planDeliverable.findMany({
      where: { planId: params.planId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    return NextResponse.json({ data: rows });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, createDeliverableSchema);

    const plan = await requirePlanInProject(params.planId, params.projectId);
    if (plan.status !== 'draft') {
      throw new AppError(
        ErrorCode.STATE_CONFLICT,
        'Only draft plans can have deliverables added — propose a new plan version instead',
      );
    }

    const created = await prisma.$transaction(async (tx) => {
      try {
        const row = await tx.planDeliverable.create({
          data: {
            planId: params.planId,
            slug: body.slug,
            title: body.title,
            body: body.body,
            refType: body.refType ?? 'free',
            refUri: body.refUri ?? null,
            status: body.status ?? 'active',
          },
        });
        await syncDeliverableArrayMirror(params.planId, tx);
        return row;
      } catch (err) {
        // (planId, slug) UNIQUE — surface a clean BAD_REQUEST instead of
        // letting Prisma's P2002 leak through as 500.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new AppError(
            ErrorCode.STATE_CONFLICT,
            `Deliverable slug "${body.slug}" already exists on this plan`,
          );
        }
        throw err;
      }
    });

    await createActivity({
      projectId: params.projectId,
      type: 'plan_draft_updated',
      actorName: auth.userName,
      actorType: auth.projectMemberType ?? 'human',
      summary: `Added deliverable "${created.slug}" to Plan v${plan.version}`,
      metadata: {
        planId: params.planId,
        deliverableId: created.id,
        deliverableSlug: created.slug,
        op: 'deliverable_create',
      },
    });

    eventBus.publish(params.projectId, 'plan_draft_updated', {
      planId: params.planId,
      version: plan.version,
      updatedBy: auth.userName,
      fields: ['deliverables'],
    });
    dispatchWebhooks(params.projectId, 'plan_draft_updated', {
      planId: params.planId,
      version: plan.version,
      updatedBy: auth.userName,
      fields: ['deliverables'],
    });

    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

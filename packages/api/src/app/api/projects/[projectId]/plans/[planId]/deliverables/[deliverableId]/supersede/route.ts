import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { AppError, ErrorCode } from '@plansync/shared';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { createActivity } from '@/lib/activity';
import { requirePlanInProject } from '@/lib/plan-scope';

// R-155 supersede route. Manual counterpart to the activate-time
// `supersedeDeliverables` helper (R-152): lets an owner explicitly mark a
// single deliverable as deprecated and (optionally) link it to a successor
// row. Useful when retiring an item without bumping the whole plan
// version — e.g. a deliverable that was descoped mid-iteration.
//
// Body shape:
//   {}                                     → status='deprecated', no link
//   { supersededById: '<other-row-id>' }   → status='deprecated', link set
//
// Constraints:
//   - the successor (if provided) must live on the same project so
//     supersede chains never cross project boundaries.
//   - the successor must NOT be the row itself (otherwise we'd build a
//     cycle pointing at self).

const supersedeBodySchema = z.object({
  supersededById: z.string().min(1).optional(),
});

type Params = {
  params: Promise<{ projectId: string; planId: string; deliverableId: string }>;
};

export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, supersedeBodySchema);

    const plan = await requirePlanInProject(params.planId, params.projectId);
    const target = await prisma.planDeliverable.findUnique({
      where: { id: params.deliverableId },
    });
    if (!target || target.planId !== params.planId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Deliverable not found');
    }

    // Validate successor (when provided): exists, lives on a plan inside
    // this project, and is not the same row.
    let successorPlanVersion: number | null = null;
    if (body.supersededById) {
      if (body.supersededById === params.deliverableId) {
        throw new AppError(ErrorCode.BAD_REQUEST, 'A deliverable cannot supersede itself');
      }
      const successor = await prisma.planDeliverable.findUnique({
        where: { id: body.supersededById },
        include: { plan: { select: { projectId: true, version: true } } },
      });
      if (!successor || successor.plan.projectId !== params.projectId) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Successor deliverable not found');
      }
      successorPlanVersion = successor.plan.version;
    }

    const updated = await prisma.planDeliverable.update({
      where: { id: params.deliverableId },
      data: {
        status: 'deprecated',
        supersededById: body.supersededById ?? null,
      },
    });

    await createActivity({
      projectId: params.projectId,
      type: 'plan_draft_updated',
      actorName: auth.userName,
      actorType: auth.projectMemberType ?? 'human',
      summary: body.supersededById
        ? `Superseded deliverable "${target.slug}" on Plan v${plan.version}` +
          (successorPlanVersion !== null ? ` (replaced by row on v${successorPlanVersion})` : '')
        : `Deprecated deliverable "${target.slug}" on Plan v${plan.version}`,
      metadata: {
        planId: params.planId,
        deliverableId: updated.id,
        deliverableSlug: updated.slug,
        op: 'deliverable_supersede',
        supersededById: body.supersededById ?? null,
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

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

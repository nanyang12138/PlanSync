import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { AppError, ErrorCode, updateDeliverableSchema } from '@plansync/shared';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { createActivity } from '@/lib/activity';
import { requirePlanInProject } from '@/lib/plan-scope';
import { syncDeliverableArrayMirror } from '@/lib/plan-items';

// R-155 detail route: GET (any member) and PATCH (owner). Both verify the
// `(projectId, planId, deliverableId)` chain so a developer in project A
// cannot probe / mutate a deliverable in project B by knowing its row id —
// same defense as `requirePlanInProject` for plan-scoped routes (R-041).

type Params = {
  params: Promise<{ projectId: string; planId: string; deliverableId: string }>;
};

async function loadDeliverableInPlan(
  deliverableId: string,
  planId: string,
  projectId: string,
): Promise<NonNullable<Awaited<ReturnType<typeof prisma.planDeliverable.findUnique>>>> {
  await requirePlanInProject(planId, projectId);
  const row = await prisma.planDeliverable.findUnique({
    where: { id: deliverableId },
  });
  // Collapse "wrong plan" and "wrong project" into the same NOT_FOUND so
  // callers cannot probe row ids across plans / projects.
  if (!row || row.planId !== planId) {
    throw new AppError(ErrorCode.NOT_FOUND, 'Deliverable not found');
  }
  return row;
}

export async function GET(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const row = await loadDeliverableInPlan(params.deliverableId, params.planId, params.projectId);
    return NextResponse.json({ data: row });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, updateDeliverableSchema);

    const plan = await requirePlanInProject(params.planId, params.projectId);
    if (plan.status !== 'draft') {
      throw new AppError(
        ErrorCode.STATE_CONFLICT,
        'Only deliverables on draft plans can be edited — propose a new plan version instead',
      );
    }
    const existing = await prisma.planDeliverable.findUnique({
      where: { id: params.deliverableId },
    });
    if (!existing || existing.planId !== params.planId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Deliverable not found');
    }

    // Build the patch payload. Treat `null` on refType/refUri as "clear",
    // missing as "leave as-is". status is non-null in the schema so it can
    // only be set, not cleared (deprecating uses status='deprecated' or the
    // dedicated supersede route).
    const data: {
      title?: string;
      body?: string;
      refType?: string | null;
      refUri?: string | null;
      status?: string;
    } = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.body !== undefined) data.body = body.body;
    if (body.refType !== undefined) data.refType = body.refType;
    if (body.refUri !== undefined) data.refUri = body.refUri;
    if (body.status !== undefined) data.status = body.status;

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.planDeliverable.update({
        where: { id: params.deliverableId },
        data,
      });
      // Title or status changes alter what the legacy String[] mirror
      // should look like (the mirror stores titles, which double as the
      // free-text item form). Re-derive after every write so plan_show
      // and any drift fallback path keep observing a consistent view.
      if (body.title !== undefined) {
        await syncDeliverableArrayMirror(params.planId, tx);
      }
      return row;
    });

    await createActivity({
      projectId: params.projectId,
      type: 'plan_draft_updated',
      actorName: auth.userName,
      actorType: auth.projectMemberType ?? 'human',
      summary: `Updated deliverable "${updated.slug}" on Plan v${plan.version}`,
      metadata: {
        planId: params.planId,
        deliverableId: updated.id,
        deliverableSlug: updated.slug,
        op: 'deliverable_update',
        fields: Object.keys(data),
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

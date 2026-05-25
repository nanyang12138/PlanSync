/**
 * R-155: single-deliverable read + update.
 *
 *   GET   — any project member; returns the row including supersededById.
 *   PATCH — owner only, draft plans only.
 *
 * Delete is intentionally NOT exposed. Removing a deliverable from a
 * draft plan should be done via `plansync_plan_update` (rewriting the
 * `deliverables` array via writeBoth) so the legacy String[] column and
 * the split table stay in lockstep. Once a plan is `proposed` or
 * `active`, the supported retire path is `supersede` (link to a new row
 * in a future plan version) — never a hard delete that would break drift
 * attribution and downstream commit-link rows (R-191).
 */
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

type Params = {
  params: Promise<{ projectId: string; planId: string; deliverableId: string }>;
};

async function loadDeliverableInPlan(
  deliverableId: string,
  planId: string,
  projectId: string,
) {
  await requirePlanInProject(planId, projectId);
  const row = await prisma.planDeliverable.findUnique({
    where: { id: deliverableId },
  });
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
    const row = await loadDeliverableInPlan(
      params.deliverableId,
      params.planId,
      params.projectId,
    );
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
        'Only deliverables on draft plans can be edited',
      );
    }

    const existing = await loadDeliverableInPlan(
      params.deliverableId,
      params.planId,
      params.projectId,
    );

    // Build a partial update from the validated body. Each optional key
    // is forwarded only when explicitly present so PATCH semantics stay
    // clean: `undefined` is "leave alone", `null` (refType / refUri) is
    // "clear the value". Status updates here are local-only; the
    // supersede endpoint is the canonical path for cross-version
    // lifecycle changes.
    const data: Record<string, unknown> = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.body !== undefined) data.body = body.body;
    if (body.refType !== undefined) data.refType = body.refType;
    if (body.refUri !== undefined) data.refUri = body.refUri;
    if (body.status !== undefined) data.status = body.status;

    const updated = await prisma.planDeliverable.update({
      where: { id: params.deliverableId },
      data,
    });

    await createActivity({
      projectId: params.projectId,
      type: 'plan_draft_updated',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Updated deliverable "${existing.slug}" on Plan v${plan.version}`,
      metadata: {
        planId: params.planId,
        deliverableId: updated.id,
        slug: updated.slug,
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

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
import { writeBoth, type SplitField } from '@/lib/plan-items';

const SPLIT_FIELDS = new Set<SplitField>(['constraints', 'standards', 'deliverables']);

const APPENDABLE_FIELDS = ['constraints', 'standards', 'deliverables', 'openQuestions'] as const;
type AppendableField = (typeof APPENDABLE_FIELDS)[number];

const appendSchema = z.object({
  field: z.enum(APPENDABLE_FIELDS),
  items: z.array(z.string().min(1).max(2000)).min(1).max(50),
});

type Params = { params: { projectId: string; planId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, appendSchema);

    const plan = await requirePlanInProject(params.planId, params.projectId);
    if (plan.status !== 'draft') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Only draft plans can be edited');
    }

    const field = body.field as AppendableField;
    const existing = (plan as unknown as Record<AppendableField, string[]>)[field];
    const existingTrimmed = new Set(existing.map((s) => s.trim()));
    const newItems = body.items.map((s) => s.trim()).filter((s) => !existingTrimmed.has(s));
    const merged = existing.concat(newItems);

    // R-152: append must hit the split table for fields that have one.
    // openQuestions does not (it remains an opaque String[] today, no per-
    // item identity needed yet — see the writeBoth doc-comment). Both code
    // paths produce the same legacy String[] result, so plan_show is stable
    // either way; the difference is whether new PlanDeliverable / Constraint
    // / Standard rows materialise alongside.
    let updated;
    if (SPLIT_FIELDS.has(field as SplitField)) {
      updated = await prisma.$transaction(async (tx) => {
        await writeBoth(params.planId, { [field as SplitField]: merged }, tx);
        return tx.plan.findUniqueOrThrow({ where: { id: params.planId } });
      });
    } else {
      updated = await prisma.plan.update({
        where: { id: params.planId },
        data: { [field]: merged },
      });
    }

    await createActivity({
      projectId: params.projectId,
      type: 'plan_draft_updated',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Appended ${newItems.length} item(s) to ${field} on Plan v${plan.version}`,
      metadata: { planId: params.planId, field, addedCount: newItems.length },
    });

    eventBus.publish(params.projectId, 'plan_draft_updated', {
      planId: updated.id,
      version: updated.version,
      updatedBy: auth.userName,
      fields: [field],
    });
    dispatchWebhooks(params.projectId, 'plan_draft_updated', {
      planId: updated.id,
      version: updated.version,
      updatedBy: auth.userName,
      fields: [field],
    });

    return NextResponse.json({
      data: {
        planId: updated.id,
        field,
        addedCount: newItems.length,
        skippedDuplicateCount: body.items.length - newItems.length,
        currentLength: merged.length,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

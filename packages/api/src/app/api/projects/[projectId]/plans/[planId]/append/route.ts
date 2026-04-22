import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { AppError, ErrorCode } from '@plansync/shared';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { createActivity } from '@/lib/activity';

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
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, appendSchema);

    const plan = await prisma.plan.findUnique({ where: { id: params.planId } });
    if (!plan || plan.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    }
    if (plan.status !== 'draft') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Only draft plans can be edited');
    }

    const field = body.field as AppendableField;
    const existing = (plan as unknown as Record<AppendableField, string[]>)[field];
    const existingTrimmed = new Set(existing.map((s) => s.trim()));
    const newItems = body.items.map((s) => s.trim()).filter((s) => !existingTrimmed.has(s));
    const merged = existing.concat(newItems);

    const updated = await prisma.plan.update({
      where: { id: params.planId },
      data: { [field]: merged },
    });

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

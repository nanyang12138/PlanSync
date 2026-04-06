import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';

type Params = { params: { projectId: string; planId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');

    type ReviewerSpec = string | { name: string; focusNotes?: string };
    let body: { reviewers?: ReviewerSpec[] } = {};
    try {
      body = await req.json();
    } catch {
      /* empty body OK if requiredReviewers on plan */
    }

    const plan = await prisma.plan.findUnique({ where: { id: params.planId } });
    if (!plan) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    if (plan.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    }
    if (plan.status !== 'draft') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Only draft plans can be proposed');
    }

    // Normalize reviewer specs to {name, focusNotes} objects
    const reviewerSpecs: Array<{ name: string; focusNotes?: string }> =
      body.reviewers && body.reviewers.length > 0
        ? body.reviewers.map((r) =>
            typeof r === 'string' ? { name: r } : { name: r.name, focusNotes: r.focusNotes },
          )
        : plan.requiredReviewers.map((r) => ({ name: r }));

    const reviewerNames = reviewerSpecs.map((r) => r.name);

    const updated = await prisma.$transaction(async (tx) => {
      const p = await tx.plan.update({
        where: { id: params.planId },
        data: { status: 'proposed', requiredReviewers: reviewerNames },
      });

      if (reviewerSpecs.length > 0) {
        await tx.planReview.createMany({
          data: reviewerSpecs.map((r) => ({
            planId: plan.id,
            reviewerName: r.name,
            focusNotes: r.focusNotes,
            status: 'pending',
          })),
        });
      }

      return p;
    });

    await createActivity({
      projectId: params.projectId,
      type: 'plan_proposed',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Plan v${plan.version} proposed for review`,
      metadata: { planId: plan.id, version: plan.version },
    });

    eventBus.publish(params.projectId, 'plan_proposed', {
      planId: plan.id,
      version: plan.version,
      title: plan.title,
      proposedBy: auth.userName,
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

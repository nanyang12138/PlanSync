import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { eventBus } from '@/lib/event-bus';
import { sendMail, userEmail } from '@/lib/email';
import { logger } from '@/lib/logger';
import { requirePlanInProject } from '@/lib/plan-scope';

type Params = { params: Promise<{ projectId: string; planId: string }> };

export async function GET(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    await requirePlanInProject(params.planId, params.projectId);

    const reviews = await prisma.planReview.findMany({
      where: { planId: params.planId },
      orderBy: { createdAt: 'asc' },
    });

    return NextResponse.json({ data: reviews });
  } catch (error) {
    return handleApiError(error);
  }
}

/** Add a reviewer to a plan that is in proposed status. */
export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');

    const body: { reviewer?: string } = await req.json().catch(() => ({}));
    const reviewer = body.reviewer?.trim();
    if (!reviewer) throw new AppError(ErrorCode.VALIDATION_ERROR, 'reviewer is required');

    const plan = await requirePlanInProject(params.planId, params.projectId);
    if (plan.status !== 'proposed')
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Can only add reviewers to a proposed plan');

    // Upsert: create if not exists, ignore if already present
    const existing = await prisma.planReview.findUnique({
      where: { planId_reviewerName: { planId: params.planId, reviewerName: reviewer } },
    });
    if (existing) throw new AppError(ErrorCode.CONFLICT, `${reviewer} is already a reviewer`);

    // CAS guard on plan.update: require status is still 'proposed' inside the
    // transaction so a concurrent activate that commits between the outer status
    // check (L43) and this update does not silently add a reviewer to an already-
    // active plan (#2262). If the update matches 0 rows (status flipped to active),
    // Prisma throws a "Record not found" error and rolls back PlanReview.create too.
    const [review] = await prisma.$transaction([
      prisma.planReview.create({
        data: { planId: params.planId, reviewerName: reviewer, status: 'pending' },
      }),
      prisma.plan.update({
        where: { id: params.planId, status: 'proposed' },
        data: { requiredReviewers: { push: reviewer } },
      }),
    ]);

    // Notify the newly added reviewer
    const [reviewerMember, notifyPlan] = await Promise.all([
      prisma.projectMember.findUnique({
        where: { projectId_name: { projectId: params.projectId, name: reviewer } },
        select: { type: true },
      }),
      prisma.plan.findUnique({
        where: { id: params.planId },
        select: { title: true, version: true },
      }),
    ]);
    if (notifyPlan) {
      const reviewEventPayload = {
        planId: params.planId,
        reviewer,
        version: notifyPlan.version,
      };
      eventBus.publish(params.projectId, 'review_requested', reviewEventPayload);
      // Push to the reviewer's personal channel — they may not be subscribed to
      // the project SSE stream yet if they were just added.
      eventBus.publishToUser(reviewer, 'review_requested', params.projectId, reviewEventPayload);
      if (reviewerMember?.type === 'human') {
        const mailBody = [
          `You have been added as a reviewer for plan "${notifyPlan.title}" (v${notifyPlan.version}).`,
          '',
          'Please log in to PlanSync to approve or reject this plan.',
        ].join('\n');
        const ok = sendMail(
          [userEmail(reviewer)],
          `[PlanSync] Review requested: "${notifyPlan.title}"`,
          mailBody,
        );
        if (!ok)
          logger.warn({ planId: params.planId }, 'Failed to send reviewer notification email');
      }
    }

    return NextResponse.json({ data: review }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

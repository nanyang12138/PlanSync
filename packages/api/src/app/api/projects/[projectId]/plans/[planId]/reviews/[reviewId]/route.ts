import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { reviewActionSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { sendMail, userEmail } from '@/lib/email';

type Params = { params: { projectId: string; planId: string; reviewId: string } };

async function handleReviewAction(
  req: NextRequest,
  { params }: Params,
  action: 'approved' | 'rejected',
) {
  const auth = await authenticate(req);
  const member = await requireProjectRole(auth, params.projectId);
  const body = await validateBody(req, reviewActionSchema);

  const review = await prisma.planReview.findFirst({
    where: {
      id: params.reviewId,
      planId: params.planId,
      plan: { projectId: params.projectId },
    },
  });
  if (!review) throw new AppError(ErrorCode.NOT_FOUND, 'Review not found');

  if (review.reviewerName !== auth.userName) {
    // Owner may act on behalf of agent reviewers only — not human reviewers
    if (member.projectRole !== 'owner') {
      throw new AppError(ErrorCode.FORBIDDEN, 'Only the assigned reviewer can approve/reject');
    }
    const reviewerMember = await prisma.projectMember.findUnique({
      where: { projectId_name: { projectId: params.projectId, name: review.reviewerName } },
    });
    if (!reviewerMember || reviewerMember.type !== 'agent') {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Owners can only act on behalf of agent reviewers, not human reviewers',
      );
    }
  }
  if (review.status !== 'pending') {
    throw new AppError(ErrorCode.STATE_CONFLICT, 'Review already resolved');
  }

  const updated = await prisma.planReview.update({
    where: { id: params.reviewId },
    data: { status: action, comment: body.comment },
  });

  const activityType = action === 'approved' ? 'review_approved' : 'review_rejected';
  await createActivity({
    projectId: params.projectId,
    type: activityType,
    actorName: auth.userName,
    actorType: 'human',
    summary: `Review ${action} by ${auth.userName}`,
    metadata: { reviewId: review.id, planId: params.planId },
  });

  // Notify project owners of the review decision
  const [plan, owners] = await Promise.all([
    prisma.plan.findUnique({
      where: { id: params.planId },
      select: { title: true, version: true },
    }),
    prisma.projectMember.findMany({
      where: { projectId: params.projectId, role: 'owner', type: 'human' },
      select: { name: true },
    }),
  ]);
  if (plan) {
    const eventType = action === 'approved' ? 'review_approved' : 'review_rejected';
    const reviewResultPayload = {
      planId: params.planId,
      reviewId: params.reviewId,
      reviewer: auth.userName,
      action,
    };
    eventBus.publish(params.projectId, eventType, reviewResultPayload);
    for (const o of owners) {
      eventBus.publishToUser(o.name, eventType, params.projectId, reviewResultPayload);
    }
    if (owners.length > 0) {
      const commentLine = body.comment ? `\nComment: ${body.comment}` : '';
      const mailBody = [
        `${auth.userName} has ${action} plan "${plan.title}" (v${plan.version}).${commentLine}`,
        '',
        'Log in to PlanSync to see the full review status.',
      ].join('\n');
      sendMail(
        owners.map((o) => userEmail(o.name)),
        `[PlanSync] Review ${action}: "${plan.title}"`,
        mailBody,
      );
    }
  }

  return NextResponse.json({ data: updated });
}

export async function POST(req: NextRequest, props: Params) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action');

    if (action === 'approve') return await handleReviewAction(req, props, 'approved');
    if (action === 'reject') return await handleReviewAction(req, props, 'rejected');

    throw new AppError(ErrorCode.BAD_REQUEST, 'Action must be "approve" or "reject"');
  } catch (error) {
    return handleApiError(error);
  }
}

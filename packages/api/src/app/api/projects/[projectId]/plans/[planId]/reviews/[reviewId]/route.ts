import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { reviewActionSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';

type Params = { params: { projectId: string; planId: string; reviewId: string } };

async function handleReviewAction(
  req: NextRequest,
  { params }: Params,
  action: 'approved' | 'rejected',
) {
  const auth = await authenticate(req);
  await requireProjectRole(auth, params.projectId);
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
    throw new AppError(ErrorCode.FORBIDDEN, 'Only the assigned reviewer can approve/reject');
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

  return NextResponse.json({ data: updated });
}

export async function POST(req: NextRequest, props: Params) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action');

    if (action === 'approve') return handleReviewAction(req, props, 'approved');
    if (action === 'reject') return handleReviewAction(req, props, 'rejected');

    throw new AppError(ErrorCode.BAD_REQUEST, 'Action must be "approve" or "reject"');
  } catch (error) {
    return handleApiError(error);
  }
}

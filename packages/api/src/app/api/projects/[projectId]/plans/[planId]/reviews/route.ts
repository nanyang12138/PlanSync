import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';

type Params = { params: { projectId: string; planId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

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
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');

    const body: { reviewer?: string } = await req.json().catch(() => ({}));
    const reviewer = body.reviewer?.trim();
    if (!reviewer) throw new AppError(ErrorCode.VALIDATION_ERROR, 'reviewer is required');

    const plan = await prisma.plan.findUnique({ where: { id: params.planId } });
    if (!plan || plan.projectId !== params.projectId)
      throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    if (plan.status !== 'proposed')
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Can only add reviewers to a proposed plan');

    // Upsert: create if not exists, ignore if already present
    const existing = await prisma.planReview.findUnique({
      where: { planId_reviewerName: { planId: params.planId, reviewerName: reviewer } },
    });
    if (existing) throw new AppError(ErrorCode.CONFLICT, `${reviewer} is already a reviewer`);

    const [review] = await prisma.$transaction([
      prisma.planReview.create({
        data: { planId: params.planId, reviewerName: reviewer, status: 'pending' },
      }),
      prisma.plan.update({
        where: { id: params.planId },
        data: { requiredReviewers: { push: reviewer } },
      }),
    ]);

    return NextResponse.json({ data: review }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

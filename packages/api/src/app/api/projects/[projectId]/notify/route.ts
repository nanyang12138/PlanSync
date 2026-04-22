import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { sendMail, userEmail } from '@/lib/email';
import { AppError, ErrorCode } from '@plansync/shared';
import { logger } from '@/lib/logger';

type Params = { params: { projectId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    const body = (await req.json()) as { type?: string; planId?: string };
    const { type, planId } = body;

    if (!type || !planId) throw new AppError(ErrorCode.BAD_REQUEST, 'type and planId are required');

    const plan = await prisma.plan.findFirst({
      where: { id: planId, projectId: params.projectId },
      include: { reviews: true },
    });
    if (!plan) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');

    const project = await prisma.project.findUnique({
      where: { id: params.projectId },
      select: { name: true, createdBy: true },
    });

    const sent: string[] = [];

    if (type === 'plan_reviewers') {
      const pendingReviewers = plan.reviews
        .filter((r) => r.status === 'pending')
        .map((r) => r.reviewerName);
      if (pendingReviewers.length === 0) return NextResponse.json({ sent: [] });

      const sent1 = sendMail(
        pendingReviewers.map(userEmail),
        `[PlanSync] Review requested: "${plan.title}" v${plan.version} — ${project?.name}`,
        [
          `Your review is requested for the following plan:`,
          ``,
          `  Project : ${project?.name}`,
          `  Plan    : v${plan.version} — ${plan.title}`,
          `  Goal    : ${plan.goal}`,
          ``,
          `Please log in to PlanSync to approve or reject the plan.`,
          ``,
          `— PlanSync`,
        ].join('\n'),
      );
      if (!sent1)
        logger.warn({ planId, pendingReviewers }, 'Failed to send reviewer notification email');
      sent.push(...pendingReviewers);
    } else if (type === 'plan_owner') {
      const owner = plan.createdBy ?? project?.createdBy;
      if (!owner) throw new AppError(ErrorCode.NOT_FOUND, 'Plan owner not found');

      const approved = plan.reviews.filter((r) => r.status === 'approved').length;
      const pending = plan.reviews.filter((r) => r.status === 'pending').length;
      const rejected = plan.reviews.filter((r) => r.status === 'rejected').length;

      const sent2 = sendMail(
        [userEmail(owner)],
        `[PlanSync] Review update: "${plan.title}" v${plan.version} — ${project?.name}`,
        [
          `Hi ${owner},`,
          ``,
          `Here is the current review status for your plan:`,
          ``,
          `  Project  : ${project?.name}`,
          `  Plan     : v${plan.version} — ${plan.title}`,
          `  Approved : ${approved}`,
          `  Pending  : ${pending}`,
          `  Rejected : ${rejected}`,
          ``,
          `— PlanSync`,
        ].join('\n'),
      );
      if (!sent2) logger.warn({ planId, owner }, 'Failed to send owner notification email');
      sent.push(owner);
    } else {
      throw new AppError(ErrorCode.BAD_REQUEST, `Unknown notify type: ${type}`);
    }

    return NextResponse.json({ sent });
  } catch (error) {
    return handleApiError(error);
  }
}

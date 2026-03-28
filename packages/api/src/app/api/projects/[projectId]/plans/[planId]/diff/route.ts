import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { getOrCreatePlanDiff } from '@/lib/ai/plan-diff';
import { AppError, ErrorCode } from '@plansync/shared';

type Params = { params: { projectId: string; planId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    const compareWith = req.nextUrl.searchParams.get('compareWith');
    if (!compareWith) {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        'compareWith query param required (plan ID to compare against)',
      );
    }

    const [planA, planB] = await Promise.all([
      prisma.plan.findUnique({ where: { id: compareWith } }),
      prisma.plan.findUnique({ where: { id: params.planId } }),
    ]);
    if (!planA || !planB) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    if (planA.projectId !== params.projectId || planB.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    }

    const diff = await getOrCreatePlanDiff(params.projectId, compareWith, params.planId);
    if (!diff) {
      return NextResponse.json({
        data: null,
        message:
          'AI not available or plans not found. Set LLM_API_KEY (internal) or ANTHROPIC_API_KEY to enable.',
      });
    }

    return NextResponse.json({ data: diff });
  } catch (error) {
    return handleApiError(error);
  }
}

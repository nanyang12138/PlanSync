import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';

type Params = { params: { projectId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    const plan = await prisma.plan.findFirst({
      where: { projectId: params.projectId, status: 'active' },
      include: { reviews: true },
    });

    if (!plan) throw new AppError(ErrorCode.NOT_FOUND, 'No active plan found');

    return NextResponse.json({ data: plan });
  } catch (error) {
    return handleApiError(error);
  }
}

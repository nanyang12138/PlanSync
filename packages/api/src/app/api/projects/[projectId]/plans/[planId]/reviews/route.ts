import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';

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

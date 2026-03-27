import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateSearchParams } from '@/lib/validate';
import { paginationSchema } from '@plansync/shared';

type Params = { params: { projectId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const { page, pageSize } = validateSearchParams(req, paginationSchema);
    const skip = (page - 1) * pageSize;

    const [activities, total] = await Promise.all([
      prisma.activity.findMany({
        where: { projectId: params.projectId },
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.activity.count({ where: { projectId: params.projectId } }),
    ]);

    return NextResponse.json({
      data: activities,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

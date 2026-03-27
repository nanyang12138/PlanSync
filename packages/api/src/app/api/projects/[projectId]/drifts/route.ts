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

    const status = req.nextUrl.searchParams.get('status') || undefined;
    const where = {
      projectId: params.projectId,
      ...(status ? { status } : {}),
    };

    const [drifts, total] = await Promise.all([
      prisma.driftAlert.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { task: { select: { id: true, title: true, status: true, assignee: true } } },
      }),
      prisma.driftAlert.count({ where }),
    ]);

    return NextResponse.json({
      data: drifts,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

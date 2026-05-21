import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateSearchParams } from '@/lib/validate';
import { paginationSchema, driftStatusSchema } from '@plansync/shared';

type Params = { params: { projectId: string } };

// R-042: validate `?status=` against shared driftStatusSchema so unknown
// values return 400 VALIDATION_ERROR instead of silently filtering to none.
const driftListQuerySchema = paginationSchema.extend({
  status: driftStatusSchema.optional(),
});

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const {
      page = 1,
      pageSize = 20,
      status,
    } = validateSearchParams(req, driftListQuerySchema);
    const skip = (page - 1) * pageSize;

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

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody, validateSearchParams } from '@/lib/validate';
import { createCommentSchema, paginationSchema } from '@plansync/shared';

type Params = { params: { projectId: string; planId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const { page, pageSize } = validateSearchParams(req, paginationSchema);
    const skip = (page - 1) * pageSize;

    const [comments, total] = await Promise.all([
      prisma.planComment.findMany({
        where: { planId: params.planId },
        skip,
        take: pageSize,
        orderBy: { createdAt: 'asc' },
      }),
      prisma.planComment.count({ where: { planId: params.planId } }),
    ]);

    return NextResponse.json({
      data: comments,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    const authCtx = await requireProjectRole(auth, params.projectId);
    const body = await validateBody(req, createCommentSchema);

    const member = await prisma.projectMember.findUnique({
      where: { projectId_name: { projectId: params.projectId, name: auth.userName } },
    });

    const comment = await prisma.planComment.create({
      data: {
        ...body,
        planId: params.planId,
        authorName: auth.userName,
        authorType: member?.type === 'agent' ? 'agent' : 'human',
      },
    });

    return NextResponse.json({ data: comment }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

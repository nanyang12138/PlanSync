import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody, validateSearchParams } from '@/lib/validate';
import { createCommentSchema, paginationSchema } from '@plansync/shared';
import { eventBus } from '@/lib/event-bus';
import { createActivity } from '@/lib/activity';
import { dispatchWebhooks } from '@/lib/webhook';

type Params = { params: { projectId: string; planId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const { page = 1, pageSize = 20 } = validateSearchParams(req, paginationSchema);
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

    eventBus.publish(params.projectId, 'comment_added', {
      commentId: comment.id,
      planId: params.planId,
      authorName: auth.userName,
      content: (body.content || '').slice(0, 100),
    });
    dispatchWebhooks(params.projectId, 'comment_added', {
      commentId: comment.id,
      planId: params.planId,
      authorName: auth.userName,
      content: (body.content || '').slice(0, 100),
    });

    await createActivity({
      projectId: params.projectId,
      type: 'comment_added',
      actorName: auth.userName,
      actorType: member?.type === 'agent' ? 'agent' : 'human',
      summary: `Comment on plan`,
      metadata: { commentId: comment.id, planId: params.planId },
    });

    return NextResponse.json({ data: comment }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

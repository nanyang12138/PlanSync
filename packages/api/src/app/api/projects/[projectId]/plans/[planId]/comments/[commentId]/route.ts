import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { updateCommentSchema, AppError, ErrorCode } from '@plansync/shared';

type Params = { params: { projectId: string; planId: string; commentId: string } };

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const body = await validateBody(req, updateCommentSchema);

    const comment = await prisma.planComment.findUnique({ where: { id: params.commentId } });
    if (!comment) throw new AppError(ErrorCode.NOT_FOUND, 'Comment not found');
    if (comment.authorName !== auth.userName) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Only the author can edit this comment');
    }
    if (comment.isDeleted) {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Cannot edit a deleted comment');
    }

    const updated = await prisma.planComment.update({
      where: { id: params.commentId },
      data: body,
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    const comment = await prisma.planComment.findUnique({ where: { id: params.commentId } });
    if (!comment) throw new AppError(ErrorCode.NOT_FOUND, 'Comment not found');
    if (comment.authorName !== auth.userName) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Only the author can delete this comment');
    }

    const updated = await prisma.planComment.update({
      where: { id: params.commentId },
      data: { isDeleted: true, content: '' },
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

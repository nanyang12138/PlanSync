import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { updateCommentSchema, AppError, ErrorCode } from '@plansync/shared';
import { eventBus } from '@/lib/event-bus';
import { createActivity } from '@/lib/activity';

type Params = { params: Promise<{ projectId: string; planId: string; commentId: string }> };

export async function PATCH(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    const memberAuth = await requireProjectRole(auth, params.projectId);
    const body = await validateBody(req, updateCommentSchema);

    const comment = await prisma.planComment.findFirst({
      where: {
        id: params.commentId,
        planId: params.planId,
        plan: { projectId: params.projectId },
      },
      include: { plan: { select: { version: true } } },
    });
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

    // R-109: audit-log comment edits. Edits silently rewriting prior
    // review/decision text would otherwise leave reviewers with no trace of
    // what the original wording said vs. what it was changed to — a
    // problem when a comment is the audit anchor for an approve/reject
    // decision. We write `comment_updated` only after the DB update
    // succeeds and capture the pre-edit content snapshot so reviewers can
    // reconstruct the original verbatim.
    await createActivity({
      projectId: params.projectId,
      type: 'comment_updated',
      actorName: auth.userName,
      // Closes #762: hardcoding 'human' mislabels agent-driven edits in
      // the audit feed. Use the membership type derived in
      // requireProjectRole (defaults to 'human' for legacy rows).
      actorType: memberAuth.projectMemberType ?? 'human',
      summary: `Comment on plan v${comment.plan.version} edited`,
      metadata: {
        planId: params.planId,
        commentId: params.commentId,
        authorName: comment.authorName,
        previousContent: comment.content,
      },
    });

    eventBus.publish(params.projectId, 'comment_updated', {
      planId: params.planId,
      commentId: params.commentId,
      authorName: comment.authorName,
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    const authCtx = await requireProjectRole(auth, params.projectId);

    const comment = await prisma.planComment.findFirst({
      where: {
        id: params.commentId,
        planId: params.planId,
        plan: { projectId: params.projectId },
      },
      include: { plan: { select: { version: true } } },
    });
    if (!comment) throw new AppError(ErrorCode.NOT_FOUND, 'Comment not found');
    if (comment.authorName !== auth.userName && authCtx.projectRole !== 'owner') {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Only the author or a project owner can delete this comment',
      );
    }
    // Closes #763 + R7 #953: the original guard
    //   if (comment.isDeleted) throw STATE_CONFLICT
    // was non-atomic. Two concurrent DELETEs that BOTH observed
    // isDeleted=false in the read above each issued an update and
    // each wrote an audit row — exactly the duplicate-delete event
    // problem #763 was supposed to close.
    //
    // Move the "are we the first deleter" check INTO the SQL WHERE
    // clause via updateMany. The Postgres row lock guarantees
    // exactly one updater sees count=1; everyone else sees count=0
    // and bails before the audit write. R-109's per-delete
    // Activity row is therefore at-most-once even under concurrent
    // contention.
    const flip = await prisma.planComment.updateMany({
      where: { id: params.commentId, isDeleted: false },
      data: { isDeleted: true, content: '' },
    });
    if (flip.count === 0) {
      // Either the row no longer exists (caller raced with a hard
      // delete elsewhere) or another concurrent DELETE already
      // soft-deleted it. Either way the resource is already in the
      // requested state — return STATE_CONFLICT so the caller knows
      // their write was a no-op.
      throw new AppError(
        ErrorCode.STATE_CONFLICT,
        'Comment is already deleted; refusing to write a duplicate audit row',
      );
    }
    const updated = await prisma.planComment.findUniqueOrThrow({
      where: { id: params.commentId },
    });

    // R-109: audit-log comment soft-delete. Owners can delete any
    // member's comment (including review comments tied to approve/reject
    // decisions), so the audit feed must record who removed what and
    // whether the deleter was the author or an owner override. We write
    // `comment_deleted` after the soft-delete succeeds and capture the
    // pre-delete content snapshot for forensic recovery.
    await createActivity({
      projectId: params.projectId,
      type: 'comment_deleted',
      actorName: auth.userName,
      // Closes #762 — see PATCH branch above for rationale.
      actorType: authCtx.projectMemberType ?? 'human',
      summary:
        comment.authorName === auth.userName
          ? `Comment on plan v${comment.plan.version} deleted by author`
          : `Comment on plan v${comment.plan.version} deleted by owner`,
      metadata: {
        planId: params.planId,
        commentId: params.commentId,
        authorName: comment.authorName,
        deletedByAuthor: comment.authorName === auth.userName,
        previousContent: comment.content,
      },
    });

    eventBus.publish(params.projectId, 'comment_deleted', {
      planId: params.planId,
      commentId: params.commentId,
      authorName: comment.authorName,
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

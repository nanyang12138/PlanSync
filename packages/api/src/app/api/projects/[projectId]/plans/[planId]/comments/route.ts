import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { AppError, ErrorCode } from '@plansync/shared';
import { handleApiError } from '@/lib/errors';
import { validateBody, validateSearchParams } from '@/lib/validate';
import { createCommentSchema, paginationSchema, listCommentsQuerySchema } from '@plansync/shared';

// R-156: merge pagination + deliverableId into one query schema so the
// comments listing endpoint can be filtered to a single deliverable.
const commentsListQuerySchema = paginationSchema.merge(listCommentsQuerySchema);
import { eventBus } from '@/lib/event-bus';
import { createActivity } from '@/lib/activity';
import { dispatchWebhooks } from '@/lib/webhook';
import { requirePlanInProject } from '@/lib/plan-scope';

type Params = { params: Promise<{ projectId: string; planId: string }> };

export async function GET(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    await requirePlanInProject(params.planId, params.projectId);
    // R-156: accept both pagination + deliverableId in the same query string.
    // The merged schema keeps the existing pagination contract unchanged and
    // adds the deliverableId filter as a purely additive option.
    const {
      page = 1,
      pageSize = 20,
      deliverableId,
    } = validateSearchParams(req, commentsListQuerySchema);
    const skip = (page - 1) * pageSize;

    const where: { planId: string; deliverableId?: string } = { planId: params.planId };
    if (deliverableId) {
      // R-156: callers asking for "comments on deliverable X" must not see
      // rows that belong to deliverables on a different plan — the planId
      // clause above already scopes by plan, so this filter is safe.
      where.deliverableId = deliverableId;
    }

    const [comments, total] = await Promise.all([
      prisma.planComment.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'asc' },
      }),
      prisma.planComment.count({ where }),
    ]);

    return NextResponse.json({
      data: comments,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    await requirePlanInProject(params.planId, params.projectId);
    const body = await validateBody(req, createCommentSchema);

    // #162: when threading a reply, refuse to anchor it to a parent comment
    // that belongs to a different plan. Without this check the DB would
    // happily store a cross-plan parent_id, and the new R-086
    // onDelete=Restrict on PlanComment.parent would then block deletion of
    // the unrelated plan's comment thread (or, after a Plan-cascade delete,
    // leave the reply orphaned in JS view-models that still join through
    // parent_id). The 404 also avoids leaking the existence of comments in
    // other plans the caller may not have access to.
    //
    // #1257 (R-156 follow-up): also load the parent's deliverableId so we
    // can either inherit it (when the reply omits the field) or validate
    // that it matches (when the reply sets one explicitly). Without this,
    // a "Reply" button on a deliverable-A comment that doesn't forward
    // deliverableId silently drops the reply onto the plan-level thread,
    // and an over-eager caller can attach the reply to deliverable B
    // breaking the timeline grouping.
    let parentDeliverableId: string | null = null;
    if (body.parentId) {
      const parent = await prisma.planComment.findUnique({
        where: { id: body.parentId },
        select: { planId: true, isDeleted: true, deliverableId: true },
      });
      if (!parent || parent.planId !== params.planId) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Parent comment not found in this plan', {
          parentId: body.parentId,
          planId: params.planId,
        });
      }
      if (parent.isDeleted) {
        throw new AppError(
          ErrorCode.BAD_REQUEST,
          'Parent comment has been deleted; pick a different parent or post a top-level reply',
          { parentId: body.parentId },
        );
      }
      parentDeliverableId = parent.deliverableId;
    }

    // #1257: when a reply explicitly sets deliverableId, it must agree
    // with the parent's deliverableId (both null = plan-level thread,
    // or both equal to the same deliverable id). Splitting a thread
    // across deliverables would produce orphaned replies in the
    // timeline UI and break the per-deliverable filter contract.
    if (body.parentId && body.deliverableId !== undefined) {
      if (body.deliverableId !== parentDeliverableId) {
        throw new AppError(
          ErrorCode.BAD_REQUEST,
          'Reply deliverableId must match parent comment deliverableId',
          {
            parentId: body.parentId,
            parentDeliverableId,
            replyDeliverableId: body.deliverableId,
          },
        );
      }
    }

    // #1257: resolve the effective deliverableId — explicit value wins
    // (already validated against the parent above when applicable),
    // otherwise inherit the parent's deliverableId so a reply stays on
    // the same thread the user clicked "Reply" from.
    const effectiveDeliverableId =
      body.deliverableId !== undefined ? body.deliverableId : parentDeliverableId;

    // R-156: when anchoring a comment to a deliverable, refuse cross-plan
    // ids. The DB-level FK only enforces that the deliverable row exists;
    // without this check a caller could attach a v1 plan's comment to a v3
    // plan's deliverable, breaking the timeline UI's per-plan grouping and
    // leaking the existence of unrelated deliverables via 500 stack traces.
    //
    // We validate the *effective* deliverableId — that covers both an
    // explicit body.deliverableId and the value inherited from a parent
    // (the parent passed this same check at creation time, but the
    // deliverable may have been re-parented or deleted since, so we
    // re-check defensively).
    if (effectiveDeliverableId) {
      const deliverable = await prisma.planDeliverable.findUnique({
        where: { id: effectiveDeliverableId },
        select: { planId: true },
      });
      if (!deliverable || deliverable.planId !== params.planId) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Deliverable not found in this plan', {
          deliverableId: effectiveDeliverableId,
          planId: params.planId,
        });
      }
    }

    const member = await prisma.projectMember.findUnique({
      where: { projectId_name: { projectId: params.projectId, name: auth.userName } },
    });

    const comment = await prisma.planComment.create({
      data: {
        content: body.content,
        parentId: body.parentId,
        // R-156: deliverableId is optional; null = plan-level comment
        // (the existing default behaviour). #1257: when this is a reply,
        // the value is inherited from the parent unless the caller passed
        // an explicit (matching) deliverableId.
        deliverableId: effectiveDeliverableId,
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

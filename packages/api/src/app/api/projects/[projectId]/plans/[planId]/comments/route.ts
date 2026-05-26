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
    let parentDeliverableId: string | null | undefined;
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

    // R-156: when anchoring a comment to a deliverable, refuse cross-plan
    // ids. The DB-level FK only enforces that the deliverable row exists;
    // without this check a caller could attach a v1 plan's comment to a v3
    // plan's deliverable, breaking the timeline UI's per-plan grouping and
    // leaking the existence of unrelated deliverables via 500 stack traces.
    if (body.deliverableId) {
      const deliverable = await prisma.planDeliverable.findUnique({
        where: { id: body.deliverableId },
        select: { planId: true },
      });
      if (!deliverable || deliverable.planId !== params.planId) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Deliverable not found in this plan', {
          deliverableId: body.deliverableId,
          planId: params.planId,
        });
      }
    }

    // #1261: a reply must live on the same thread anchor as its parent.
    // The per-field checks above only prove that `parentId` and
    // `deliverableId` each belong to this plan; they say nothing about
    // whether they belong to the *same* sub-thread. Without this guard a
    // caller could reply to a plan-level comment while anchoring the
    // reply to deliverable A (or reply to a comment on deliverable A
    // while anchoring to deliverable B), splitting the conversation
    // across surfaces — the timeline UI groups by `deliverableId` so
    // half the thread would silently disappear from the deliverable card
    // and the other half from the plan-level pane.
    if (body.parentId) {
      const replyDeliverableId = body.deliverableId ?? null;
      const expectedDeliverableId = parentDeliverableId ?? null;
      if (replyDeliverableId !== expectedDeliverableId) {
        throw new AppError(
          ErrorCode.BAD_REQUEST,
          'Reply must share the same deliverable anchor as its parent comment',
          {
            parentId: body.parentId,
            parentDeliverableId: expectedDeliverableId,
            replyDeliverableId,
          },
        );
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
        // (the existing default behaviour).
        deliverableId: body.deliverableId,
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

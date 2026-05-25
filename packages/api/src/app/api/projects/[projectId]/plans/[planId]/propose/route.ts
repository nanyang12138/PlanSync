import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode, proposePlanSchema } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { sendMail, userEmail } from '@/lib/email';
import { logger } from '@/lib/logger';
import { requirePlanInProject } from '@/lib/plan-scope';

type Params = { params: Promise<{ projectId: string; planId: string }> };

export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');

    // Body is optional — empty body falls back to plan.requiredReviewers.
    // Use the shared zod schema to validate any provided fields so invalid
    // payloads (e.g. wrong type/role values, non-string names, >20 reviewers)
    // are rejected with 400 instead of silently coerced.
    let rawBody: unknown = {};
    try {
      rawBody = await req.json();
    } catch {
      rawBody = {};
    }
    const body = proposePlanSchema.parse(rawBody);

    const plan = await requirePlanInProject(params.planId, params.projectId);
    if (plan.status !== 'draft') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Only draft plans can be proposed');
    }

    // Normalize reviewer specs to {name, focusNotes} objects.
    //
    // R-205: precedence is (1) explicit body.reviewers, (2) plan.requiredReviewers
    // baseline, (3) owner self-review fallback. The owner-self fallback closes
    // the dead-end where a `proposed` plan with zero reviewers cannot be
    // activated through the normal path nor force-activated through MCP — see
    // packages/api/src/app/api/projects/[projectId]/plans/[planId]/activate/route.ts
    // R-055 gate. With this fallback the activate gate's "0 reviewers" branch
    // becomes unreachable for new plans and the state machine has no trap.
    let reviewerSpecs: Array<{ name: string; focusNotes?: string; type?: 'human' | 'agent' }>;
    let ownerSelfReviewFallback = false;
    if (body.reviewers && body.reviewers.length > 0) {
      reviewerSpecs = body.reviewers.map((r) =>
        typeof r === 'string'
          ? { name: r }
          : { name: r.name, focusNotes: r.focusNotes, type: r.type },
      );
    } else if (plan.requiredReviewers.length > 0) {
      reviewerSpecs = plan.requiredReviewers.map((r) => ({ name: r }));
    } else {
      reviewerSpecs = [
        {
          name: auth.userName,
          focusNotes: 'Owner self-review (auto-added — no reviewers were specified)',
        },
      ];
      ownerSelfReviewFallback = true;
    }

    const reviewerNames = reviewerSpecs.map((r) => r.name);

    const updated = await prisma.$transaction(async (tx) => {
      const p = await tx.plan.update({
        where: { id: params.planId },
        data: { status: 'proposed', requiredReviewers: reviewerNames },
      });

      if (reviewerSpecs.length > 0) {
        await tx.planReview.createMany({
          data: reviewerSpecs.map((r) => ({
            planId: plan.id,
            reviewerName: r.name,
            focusNotes: r.focusNotes,
            status: 'pending',
          })),
        });

        // Auto-add reviewers as project members if not already members.
        // Reviewers must be members to pass requireProjectRole during review/approve.
        await tx.projectMember.createMany({
          data: reviewerSpecs.map((r) => ({
            projectId: params.projectId,
            name: r.name,
            role: 'developer',
            type: r.type ?? 'human',
          })),
          skipDuplicates: true,
        });
      }

      return p;
    });

    await createActivity({
      projectId: params.projectId,
      type: 'plan_proposed',
      actorName: auth.userName,
      actorType: 'human',
      summary: ownerSelfReviewFallback
        ? `Plan v${plan.version} proposed for review (owner self-review — no reviewers specified)`
        : `Plan v${plan.version} proposed for review`,
      metadata: {
        planId: plan.id,
        version: plan.version,
        reviewerCount: reviewerNames.length,
        ownerSelfReviewFallback,
      },
    });

    eventBus.publish(params.projectId, 'plan_proposed', {
      planId: plan.id,
      version: plan.version,
      title: plan.title,
      proposedBy: auth.userName,
    });

    // Notify human reviewers by email + SSE
    if (reviewerNames.length > 0) {
      const members = await prisma.projectMember.findMany({
        where: { projectId: params.projectId, name: { in: reviewerNames }, type: 'human' },
        select: { name: true },
      });
      const humanReviewers = members.map((m) => m.name);
      if (humanReviewers.length > 0) {
        const mailBody = [
          `${auth.userName} submitted plan "${plan.title}" (v${plan.version}) for your review.`,
          '',
          `Please log in to PlanSync to approve or reject this plan.`,
        ].join('\n');
        const ok = sendMail(
          humanReviewers.map(userEmail),
          `[PlanSync] Review requested: "${plan.title}"`,
          mailBody,
        );
        if (!ok) logger.warn({ planId: plan.id }, 'Failed to send review notification email');

        // Push review_requested to each reviewer's personal channel so they get
        // the urgent flash even if their SSE connection pre-dates this membership.
        const reviewPayload = { planId: plan.id, version: plan.version, title: plan.title };
        for (const reviewer of humanReviewers) {
          eventBus.publishToUser(reviewer, 'review_requested', params.projectId, reviewPayload);
        }
      }
    }

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

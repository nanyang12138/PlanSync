import { NextRequest, NextResponse } from 'next/server';
import { AppError, ErrorCode } from '@plansync/shared';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const auth = await authenticate(req);

    // R-018: optional `?user=<name>` lets owners (or master delegation) query
    // pending work on behalf of another member (typically an agent like
    // "genie"). When provided and different from the caller, scope is
    // restricted to projects where the caller is an owner AND the target is
    // a member; this prevents leaking work from projects the caller has no
    // owner relationship with.
    const targetUserParam = req.nextUrl.searchParams.get('user');
    const targetUser = targetUserParam?.trim() || auth.userName;
    const isDelegated = targetUser !== auth.userName;

    // Projects where the target user is a member (humans OR agents — owners
    // commonly want to inspect an agent's pending work).
    const targetMemberships = await prisma.projectMember.findMany({
      where: isDelegated ? { name: targetUser } : { name: targetUser, type: 'human' },
      include: { project: { select: { id: true, name: true } } },
    });

    let memberships = targetMemberships;
    if (isDelegated) {
      const targetProjectIds = targetMemberships.map((m) => m.project.id);
      if (targetProjectIds.length === 0) {
        // Target isn't a member anywhere: nothing to report, but also nothing
        // to authorize. Treat as forbidden so callers cannot use this as a
        // membership oracle for arbitrary user names.
        throw new AppError(
          ErrorCode.FORBIDDEN,
          `Cannot query work for "${targetUser}": no shared project with owner privileges`,
        );
      }
      // Caller must be owner in at least one shared project.
      const ownerOf = await prisma.projectMember.findMany({
        where: {
          name: auth.userName,
          role: 'owner',
          projectId: { in: targetProjectIds },
        },
        select: { projectId: true },
      });
      if (ownerOf.length === 0) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          `Only project owners may query "/api/my-work?user=<name>"; ${auth.userName} is not an owner in any project that "${targetUser}" belongs to`,
        );
      }
      const ownerProjectIds = new Set(ownerOf.map((o) => o.projectId));
      memberships = targetMemberships.filter((m) => ownerProjectIds.has(m.project.id));
    }

    const projectIds = memberships.map((m) => m.project.id);
    const projectMap = Object.fromEntries(memberships.map((m) => [m.project.id, m.project.name]));

    if (projectIds.length === 0) {
      return NextResponse.json({ reviews: [], drifts: [], tasks: [], unreadActivityCount: 0 });
    }

    const [pendingReviews, pendingTasks, openDrifts, userState] = await Promise.all([
      // P1: Plan reviews pending for target user
      prisma.planReview.findMany({
        where: {
          reviewerName: targetUser,
          status: 'pending',
          plan: { projectId: { in: projectIds } },
        },
        include: {
          plan: {
            select: { id: true, projectId: true, title: true, version: true, createdBy: true },
          },
        },
      }),

      // P2: Tasks assigned to target user that are active.
      // R-192 / closes #1161 — include `awaiting_evidence` so tasks
      // parked by the R-192 gate (run finished, but missing git
      // evidence) keep showing up in the assignee's My Work bucket
      // until they either land the evidence and re-complete, or the
      // owner overrides the status. Without this, parked tasks
      // silently disappeared from My Work.
      prisma.task.findMany({
        where: {
          projectId: { in: projectIds },
          assignee: targetUser,
          status: { in: ['todo', 'in_progress', 'blocked', 'awaiting_evidence'] },
        },
        select: {
          id: true,
          projectId: true,
          title: true,
          status: true,
          priority: true,
          assigneeType: true,
        },
      }),

      // P0: Open drift alerts on target user's tasks (and unassigned tasks
      // when querying for self — owners querying a specific agent only see
      // that agent's drifts to avoid noise).
      prisma.driftAlert.findMany({
        where: {
          projectId: { in: projectIds },
          status: 'open',
          task: isDelegated
            ? { assignee: targetUser }
            : { OR: [{ assignee: targetUser }, { assignee: null }] },
        },
        include: {
          task: { select: { id: true, title: true, assignee: true } },
        },
      }),

      // Unread activity counter only makes sense for the authenticated user.
      isDelegated
        ? Promise.resolve(null)
        : prisma.userState.findUnique({ where: { userName: auth.userName } }),
    ]);

    const lastSeen = userState?.lastSeenActivityAt ?? null;
    const unreadActivityCount = isDelegated
      ? 0
      : await prisma.activity.count({
          where: {
            projectId: { in: projectIds },
            ...(lastSeen ? { createdAt: { gt: lastSeen } } : {}),
          },
        });

    const reviews = pendingReviews.map((r) => ({
      reviewId: r.id,
      planId: r.plan.id,
      planTitle: r.plan.title,
      version: r.plan.version,
      proposedBy: r.plan.createdBy,
      focusNotes: r.focusNotes ?? null,
      projectId: r.plan.projectId,
      projectName: projectMap[r.plan.projectId] ?? r.plan.projectId,
    }));

    const tasks = pendingTasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      projectId: t.projectId,
      projectName: projectMap[t.projectId] ?? t.projectId,
    }));

    const drifts = openDrifts.map((d) => ({
      id: d.id,
      taskId: d.taskId,
      taskTitle: d.task?.title ?? d.taskId,
      severity: d.severity,
      reason: d.reason,
      projectId: d.projectId,
      projectName: projectMap[d.projectId] ?? d.projectId,
    }));

    return NextResponse.json({ reviews, drifts, tasks, unreadActivityCount });
  } catch (error) {
    return handleApiError(error);
  }
}

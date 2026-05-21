import { NextRequest, NextResponse } from 'next/server';
import { AppError, ErrorCode } from '@plansync/shared';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const auth = await authenticate(req);

    // R-018: ?user=<name> lets an owner (or master delegation) query work on
    // behalf of another member (typically an agent in "work as <agent>" flow).
    // Without it, my_work returns work for the authenticated caller.
    const requestedUser = req.nextUrl.searchParams.get('user');
    const targetUser =
      requestedUser && requestedUser !== auth.userName ? requestedUser : auth.userName;
    const isDelegated = targetUser !== auth.userName;

    // Target user's memberships. When the caller is delegating (owner querying
    // an agent), include agent memberships too; otherwise stay with the legacy
    // human-only filter so personal queries behave the same as before.
    const targetMemberships = await prisma.projectMember.findMany({
      where: {
        name: targetUser,
        ...(isDelegated ? {} : { type: 'human' }),
      },
      include: { project: { select: { id: true, name: true } } },
    });

    let projectIds = targetMemberships.map((m) => m.project.id);

    if (isDelegated) {
      // Authorization: only allow ?user=other when the caller owns at least
      // one project the target user is a member of, and scope the response to
      // those owned projects so a non-owner cannot leak data via the alias.
      const callerOwner = await prisma.projectMember.findMany({
        where: { name: auth.userName, role: 'owner' },
        select: { projectId: true },
      });
      const ownedProjectIds = new Set(callerOwner.map((m) => m.projectId));
      if (ownedProjectIds.size === 0) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          'Only project owners can query my-work on behalf of another user',
        );
      }
      projectIds = projectIds.filter((id) => ownedProjectIds.has(id));
    }

    const projectMap = Object.fromEntries(
      targetMemberships
        .filter((m) => projectIds.includes(m.project.id))
        .map((m) => [m.project.id, m.project.name]),
    );

    if (projectIds.length === 0) {
      return NextResponse.json({ reviews: [], drifts: [], tasks: [], unreadActivityCount: 0 });
    }

    const [pendingReviews, pendingTasks, openDrifts, userState] = await Promise.all([
      // P1: Plan reviews pending for the target user
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

      // P2: Tasks assigned to target user that are active
      prisma.task.findMany({
        where: {
          projectId: { in: projectIds },
          assignee: targetUser,
          status: { in: ['todo', 'in_progress', 'blocked'] },
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

      // P0: Open drift alerts on tasks assigned to target user, plus unassigned
      // tasks in their projects (unassigned tasks have no specific owner, so we
      // surface them to all project members).
      prisma.driftAlert.findMany({
        where: {
          projectId: { in: projectIds },
          status: 'open',
          task: {
            OR: [{ assignee: targetUser }, { assignee: null }],
          },
        },
        include: {
          task: { select: { id: true, title: true, assignee: true } },
        },
      }),

      prisma.userState.findUnique({ where: { userName: targetUser } }),
    ]);

    const lastSeen = userState?.lastSeenActivityAt ?? null;
    const unreadActivityCount = await prisma.activity.count({
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

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const auth = await authenticate(req);

    // Get all projects where this user is a human member
    const memberships = await prisma.projectMember.findMany({
      where: { name: auth.userName, type: 'human' },
      include: { project: { select: { id: true, name: true } } },
    });

    const projectIds = memberships.map((m) => m.project.id);
    const projectMap = Object.fromEntries(memberships.map((m) => [m.project.id, m.project.name]));

    if (projectIds.length === 0) {
      return NextResponse.json({ reviews: [], drifts: [], tasks: [] });
    }

    const [pendingReviews, pendingTasks, openDrifts] = await Promise.all([
      // P1: Plan reviews pending for this user
      prisma.planReview.findMany({
        where: {
          reviewerName: auth.userName,
          status: 'pending',
          plan: { projectId: { in: projectIds } },
        },
        include: {
          plan: {
            select: { id: true, projectId: true, title: true, version: true, createdBy: true },
          },
        },
      }),

      // P2: Tasks assigned to user that are active
      prisma.task.findMany({
        where: {
          projectId: { in: projectIds },
          assignee: auth.userName,
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

      // P0: Open drift alerts on tasks assigned to user
      prisma.driftAlert.findMany({
        where: {
          projectId: { in: projectIds },
          status: 'open',
          task: { assignee: auth.userName },
        },
        include: {
          task: { select: { id: true, title: true, assignee: true } },
        },
      }),
    ]);

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

    return NextResponse.json({ reviews, drifts, tasks });
  } catch (error) {
    return handleApiError(error);
  }
}

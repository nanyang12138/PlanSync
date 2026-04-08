import { NextRequest, NextResponse } from 'next/server';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { sendMail, userEmail } from '@/lib/email';
import { AppError } from '@plansync/shared';

interface NotifyBody {
  type: 'plan_reviewers' | 'task_assignee' | 'plan_owner';
  planId?: string;
  taskId?: string;
}

export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  try {
    const { projectId } = params;
    const auth = await authenticate(req);
    await requireProjectRole(auth, projectId);

    const body = (await req.json()) as NotifyBody;
    const { type, planId, taskId } = body;

    const sent: string[] = [];

    if (type === 'plan_reviewers') {
      if (!planId) return NextResponse.json({ error: 'planId required' }, { status: 400 });

      const plan = await prisma.plan.findFirst({ where: { id: planId, projectId } });
      if (!plan) return NextResponse.json({ error: 'Plan not found' }, { status: 404 });

      const reviews = await prisma.planReview.findMany({
        where: { planId, status: 'pending' },
      });

      for (const review of reviews) {
        const to = userEmail(review.reviewerName);
        sendMail(
          [to],
          `[PlanSync] Review requested: v${plan.version} "${plan.title}"`,
          `Hi ${review.reviewerName},\n\n` +
            `Plan v${plan.version} "${plan.title}" is waiting for your review.\n\n` +
            (review.focusNotes ? `Focus area: ${review.focusNotes}\n\n` : '') +
            `Goal: ${plan.goal}\n\n` +
            `Please log in to PlanSync to complete your review.\n\n` +
            `— PlanSync`,
        );
        sent.push(to);
      }
    } else if (type === 'task_assignee') {
      if (!taskId) return NextResponse.json({ error: 'taskId required' }, { status: 400 });

      const task = await prisma.task.findFirst({ where: { id: taskId, projectId } });
      if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      if (!task.assignee)
        return NextResponse.json({ error: 'Task has no assignee' }, { status: 400 });

      const to = userEmail(task.assignee);
      sendMail(
        [to],
        `[PlanSync] Task assigned to you: "${task.title}"`,
        `Hi ${task.assignee},\n\n` +
          `You have a new task:\n\n` +
          `Task: ${task.title}\n` +
          `Priority: ${task.priority}\n` +
          (task.description ? `Description: ${task.description}\n` : '') +
          `\nPlease log in to PlanSync to view the details.\n\n` +
          `— PlanSync`,
      );
      sent.push(to);
    } else if (type === 'plan_owner') {
      if (!planId) return NextResponse.json({ error: 'planId required' }, { status: 400 });

      const plan = await prisma.plan.findFirst({ where: { id: planId, projectId } });
      if (!plan) return NextResponse.json({ error: 'Plan not found' }, { status: 404 });

      const reviews = await prisma.planReview.findMany({ where: { planId } });
      const approved = reviews.filter((r) => r.status === 'approved').length;
      const rejected = reviews.filter((r) => r.status === 'rejected').length;
      const pending = reviews.filter((r) => r.status === 'pending').length;

      const to = userEmail(plan.createdBy);
      sendMail(
        [to],
        `[PlanSync] Review status: v${plan.version} "${plan.title}"`,
        `Hi ${plan.createdBy},\n\n` +
          `Review status for your plan v${plan.version} "${plan.title}":\n\n` +
          `✓ Approved: ${approved}\n` +
          `✗ Rejected: ${rejected}\n` +
          `⏳ Pending: ${pending}\n\n` +
          `Please log in to PlanSync to view the details.\n\n` +
          `— PlanSync`,
      );
      sent.push(to);
    } else {
      return NextResponse.json({ error: 'Invalid notification type' }, { status: 400 });
    }

    return NextResponse.json({ sent });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Notify error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

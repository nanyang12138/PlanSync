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
          `[PlanSync] 请审核计划 v${plan.version} "${plan.title}"`,
          `${review.reviewerName} 您好，\n\n` +
            `项目计划 v${plan.version} "${plan.title}" 正在等待您的审核。\n\n` +
            (review.focusNotes ? `审核重点：${review.focusNotes}\n\n` : '') +
            `目标：${plan.goal}\n\n` +
            `请登录 PlanSync 完成审核。\n\n` +
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
        `[PlanSync] 任务已分配给您："${task.title}"`,
        `${task.assignee} 您好，\n\n` +
          `您有一个新任务待处理：\n\n` +
          `任务：${task.title}\n` +
          `优先级：${task.priority}\n` +
          (task.description ? `描述：${task.description}\n` : '') +
          `\n请登录 PlanSync 查看详情。\n\n` +
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
        `[PlanSync] 计划 v${plan.version} "${plan.title}" 审核进度`,
        `${plan.createdBy} 您好，\n\n` +
          `您的计划 v${plan.version} "${plan.title}" 审核进度：\n\n` +
          `✓ 已批准：${approved}\n` +
          `✗ 已拒绝：${rejected}\n` +
          `⏳ 待审核：${pending}\n\n` +
          `请登录 PlanSync 查看详情。\n\n` +
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

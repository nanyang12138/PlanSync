import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';

type Params = { params: { projectId: string; taskId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    const task = await prisma.task.findUnique({ where: { id: params.taskId } });
    if (!task) throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    if (task.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }

    const plan = await prisma.plan.findFirst({
      where: { projectId: params.projectId, version: task.boundPlanVersion },
    });

    const project = await prisma.project.findUnique({ where: { id: params.projectId } });

    const openDrifts = await prisma.driftAlert.findMany({
      where: { taskId: params.taskId, status: 'open' },
    });

    const taskPack = {
      task,
      plan: plan
        ? {
            version: plan.version,
            title: plan.title,
            goal: plan.goal,
            scope: plan.scope,
            constraints: plan.constraints,
            standards: plan.standards,
            deliverables: plan.deliverables,
            openQuestions: plan.openQuestions,
          }
        : null,
      project: project ? { id: project.id, name: project.name, phase: project.phase } : null,
      driftAlerts: openDrifts,
    };

    return NextResponse.json({ data: taskPack });
  } catch (error) {
    return handleApiError(error);
  }
}

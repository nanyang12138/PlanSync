import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { auditCrossProjectTaskIfNeeded } from '@/lib/task-scope';

type Params = { params: { projectId: string; taskId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    // R-135: scope by projectId to prevent cross-project task leakage.
    // #255: emit cross-project audit signal so probes via this route are
    // visible alongside the buildTaskPack signals.
    const task = await prisma.task.findFirst({
      where: { id: params.taskId, projectId: params.projectId },
    });
    if (!task) {
      await auditCrossProjectTaskIfNeeded(params.taskId, params.projectId, 'GET /pack');
      throw new AppError(ErrorCode.NOT_FOUND, 'Task not found');
    }

    const plan = await prisma.plan.findFirst({
      where: { projectId: params.projectId, version: task.boundPlanVersion },
    });

    // F2: defense-in-depth — same narrowing as buildTaskPack().
    const project = await prisma.project.findUnique({
      where: { id: params.projectId },
      select: { id: true, name: true, phase: true },
    });

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

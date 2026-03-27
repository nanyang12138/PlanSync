import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody, validateSearchParams } from '@/lib/validate';
import { createTaskSchema, paginationSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';

type Params = { params: { projectId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const { page, pageSize } = validateSearchParams(req, paginationSchema);
    const skip = (page - 1) * pageSize;

    const status = req.nextUrl.searchParams.get('status') || undefined;
    const assignee = req.nextUrl.searchParams.get('assignee') || undefined;
    const where = {
      projectId: params.projectId,
      ...(status ? { status } : {}),
      ...(assignee ? { assignee } : {}),
    };

    const [tasks, total] = await Promise.all([
      prisma.task.findMany({ where, skip, take: pageSize, orderBy: { createdAt: 'desc' } }),
      prisma.task.count({ where }),
    ]);

    return NextResponse.json({
      data: tasks,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
    const body = await validateBody(req, createTaskSchema);

    const activePlan = await prisma.plan.findFirst({
      where: { projectId: params.projectId, status: 'active' },
    });
    if (!activePlan) {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'No active plan. Activate a plan before creating tasks.');
    }

    const task = await prisma.task.create({
      data: {
        ...body,
        projectId: params.projectId,
        boundPlanVersion: activePlan.version,
      },
    });

    await createActivity({
      projectId: params.projectId,
      type: 'task_created',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Task "${task.title}" created (bound to plan v${activePlan.version})`,
      metadata: { taskId: task.id, boundPlanVersion: activePlan.version },
    });

    return NextResponse.json({ data: task }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { updateProjectSchema, AppError, ErrorCode } from '@plansync/shared';

type Params = { params: { projectId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    const project = await prisma.project.findUnique({
      where: { id: params.projectId },
      include: {
        _count: { select: { members: true, plans: true, tasks: true } },
      },
    });
    if (!project) throw new AppError(ErrorCode.NOT_FOUND, 'Project not found');

    await requireProjectRole(auth, project.id);

    const activePlan = await prisma.plan.findFirst({
      where: { projectId: project.id, status: 'active' },
    });

    const taskStats = await prisma.task.groupBy({
      by: ['status'],
      where: { projectId: project.id },
      _count: true,
    });

    return NextResponse.json({
      data: {
        ...project,
        activePlanVersion: activePlan?.version ?? null,
        taskStats: Object.fromEntries(taskStats.map((s) => [s.status, s._count])),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, updateProjectSchema);

    const project = await prisma.project.update({
      where: { id: params.projectId },
      data: body,
    });

    return NextResponse.json({ data: project });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');

    await prisma.project.delete({ where: { id: params.projectId } });
    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    return handleApiError(error);
  }
}

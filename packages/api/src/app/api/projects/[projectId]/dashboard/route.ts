import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';

type Params = { params: { projectId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    const [project, activePlan, tasks, driftAlerts, members, activities] = await Promise.all([
      prisma.project.findUnique({ where: { id: params.projectId } }),
      prisma.plan.findFirst({ where: { projectId: params.projectId, status: 'active' } }),
      prisma.task.findMany({
        where: { projectId: params.projectId },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.driftAlert.findMany({
        where: { projectId: params.projectId, status: 'open' },
        include: { task: true },
      }),
      prisma.projectMember.findMany({ where: { projectId: params.projectId } }),
      prisma.activity.findMany({
        where: { projectId: params.projectId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    return NextResponse.json({
      data: { project, activePlan, tasks, driftAlerts, members, activities },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

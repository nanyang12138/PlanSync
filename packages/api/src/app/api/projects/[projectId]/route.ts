import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { updateProjectSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
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

export async function PATCH(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, updateProjectSchema);

    const before = await prisma.project.findUnique({
      where: { id: params.projectId },
      select: { phase: true },
    });
    if (!before) throw new AppError(ErrorCode.NOT_FOUND, 'Project not found');

    const project = await prisma.project.update({
      where: { id: params.projectId },
      data: body,
    });

    // R-110: audit trail for owner-driven project edits. Records the changed
    // fields plus phase transitions (planning → active → completed) so the
    // activity log can explain *what* changed without diffing the project
    // record after the fact.
    const fields = Object.keys(body);
    const phaseChanged = body.phase !== undefined && body.phase !== before.phase;
    await createActivity({
      projectId: project.id,
      type: 'project_updated',
      actorName: auth.userName,
      actorType: 'human',
      summary:
        fields.length > 0
          ? `Project "${project.name}" updated (${fields.join(', ')})`
          : `Project "${project.name}" updated`,
      metadata: {
        fields,
        ...(phaseChanged ? { phaseFrom: before.phase, phaseTo: project.phase } : {}),
      },
    });

    return NextResponse.json({ data: project });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');

    await prisma.project.delete({ where: { id: params.projectId } });
    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    return handleApiError(error);
  }
}

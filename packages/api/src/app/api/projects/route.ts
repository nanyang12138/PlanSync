import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody, validateSearchParams } from '@/lib/validate';
import { createProjectSchema, paginationSchema } from '@plansync/shared';
import { createActivity } from '@/lib/activity';

export async function GET(req: NextRequest) {
  try {
    const auth = await authenticate(req);
    const { page, pageSize } = validateSearchParams(req, paginationSchema);
    const skip = (page - 1) * pageSize;

    const memberFilter = { members: { some: { name: auth.userName } } };
    const [projects, total] = await Promise.all([
      prisma.project.findMany({
        where: memberFilter,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.project.count({ where: memberFilter }),
    ]);

    return NextResponse.json({
      data: projects,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await authenticate(req);
    const body = await validateBody(req, createProjectSchema);

    const project = await prisma.$transaction(async (tx) => {
      const p = await tx.project.create({
        data: { ...body, createdBy: auth.userName },
      });
      await tx.projectMember.create({
        data: { projectId: p.id, name: auth.userName, role: 'owner', type: 'human' },
      });
      return p;
    });

    await createActivity({
      projectId: project.id,
      type: 'project_created',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Project "${project.name}" created`,
    });

    return NextResponse.json({ data: project }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

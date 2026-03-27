import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { createMemberSchema } from '@plansync/shared';
import { createActivity } from '@/lib/activity';

type Params = { params: { projectId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    const members = await prisma.projectMember.findMany({
      where: { projectId: params.projectId },
      orderBy: { createdAt: 'asc' },
    });

    return NextResponse.json({ data: members });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, createMemberSchema);

    const member = await prisma.projectMember.create({
      data: { ...body, projectId: params.projectId },
    });

    await createActivity({
      projectId: params.projectId,
      type: 'member_added',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Member "${member.name}" added as ${member.role}`,
      metadata: { memberId: member.id, role: member.role },
    });

    return NextResponse.json({ data: member }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

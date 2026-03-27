import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { updateMemberSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';

type Params = { params: { projectId: string; memberId: string } };

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, updateMemberSchema);

    const member = await prisma.projectMember.update({
      where: { id: params.memberId },
      data: body,
    });

    return NextResponse.json({ data: member });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');

    const member = await prisma.projectMember.findUnique({ where: { id: params.memberId } });
    if (!member) throw new AppError(ErrorCode.NOT_FOUND, 'Member not found');

    await prisma.projectMember.delete({ where: { id: params.memberId } });

    await createActivity({
      projectId: params.projectId,
      type: 'member_removed',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Member "${member.name}" removed`,
      metadata: { memberId: member.id },
    });

    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    return handleApiError(error);
  }
}

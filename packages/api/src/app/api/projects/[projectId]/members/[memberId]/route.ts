import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { updateMemberSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';

type Params = { params: { projectId: string; memberId: string } };

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await validateBody(req, updateMemberSchema);

    const existing = await prisma.projectMember.findFirst({
      where: { id: params.memberId, projectId: params.projectId },
    });
    if (!existing) throw new AppError(ErrorCode.NOT_FOUND, 'Member not found');

    if (existing.role === 'owner' && body.role && body.role !== 'owner') {
      const ownerCount = await prisma.projectMember.count({
        where: { projectId: params.projectId, role: 'owner' },
      });
      if (ownerCount <= 1) {
        throw new AppError(ErrorCode.BAD_REQUEST, 'Cannot demote the last owner');
      }
    }

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
    if (member.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Member not found');
    }

    if (member.role === 'owner') {
      const ownerCount = await prisma.projectMember.count({
        where: { projectId: params.projectId, role: 'owner' },
      });
      if (ownerCount <= 1) {
        throw new AppError(ErrorCode.BAD_REQUEST, 'Cannot remove the last owner');
      }
    }

    await prisma.projectMember.delete({ where: { id: params.memberId } });

    await createActivity({
      projectId: params.projectId,
      type: 'member_removed',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Member "${member.name}" removed`,
      metadata: { memberId: member.id },
    });

    eventBus.publish(params.projectId, 'member_removed', {
      memberId: member.id,
      memberName: member.name,
      removedBy: auth.userName,
    });

    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    return handleApiError(error);
  }
}

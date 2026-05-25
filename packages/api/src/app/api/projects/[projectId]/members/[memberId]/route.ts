import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { updateMemberSchema, AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { sendMail, userEmail } from '@/lib/email';
import { logger } from '@/lib/logger';

type Params = { params: Promise<{ projectId: string; memberId: string }> };

export async function PATCH(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
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

    await createActivity({
      projectId: params.projectId,
      type: 'member_added',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Member "${member.name}" role updated to ${member.role}`,
      metadata: { memberId: member.id, role: member.role },
    });

    const project = await prisma.project.findUnique({
      where: { id: params.projectId },
      select: { name: true },
    });
    const projectName = project?.name ?? params.projectId;
    const updatePayload = {
      name: member.name,
      role: member.role,
      type: member.type,
      projectName,
      updatedBy: auth.userName,
    };
    eventBus.publish(params.projectId, 'member_updated', updatePayload);
    eventBus.publishToUser(member.name, 'member_updated', params.projectId, updatePayload);

    if (member.type === 'human') {
      const mailBody = [
        `Your role in project "${projectName}" has been updated to ${member.role} by ${auth.userName}.`,
        '',
        'Log in to PlanSync to view your updated permissions.',
      ].join('\n');
      const ok = sendMail(
        [userEmail(member.name)],
        `[PlanSync] Your role in "${projectName}" has been updated`,
        mailBody,
      );
      if (!ok)
        logger.warn(
          { projectId: params.projectId, member: member.name },
          'Failed to send role update email',
        );
    }

    return NextResponse.json({ data: member });
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

    const project = await prisma.project.findUnique({
      where: { id: params.projectId },
      select: { name: true },
    });

    const removalPayload = {
      memberId: member.id,
      memberName: member.name,
      name: member.name, // alias so client-side reconnect logic can match either field
      removedBy: auth.userName,
      projectName: project?.name ?? params.projectId,
    };

    eventBus.publish(params.projectId, 'member_removed', removalPayload);
    // Mirror to the removed member so their client can drop the project
    // subscription via SSE reconnect.
    eventBus.publishToUser(member.name, 'member_removed', params.projectId, removalPayload);

    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    return handleApiError(error);
  }
}

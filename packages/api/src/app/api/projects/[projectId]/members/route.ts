import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { createMemberSchema } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { sendMail, userEmail } from '@/lib/email';
import { logger } from '@/lib/logger';

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
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

export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
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

    const project = await prisma.project.findUnique({
      where: { id: params.projectId },
      select: { name: true },
    });

    const eventPayload = {
      name: member.name,
      role: member.role,
      type: member.type,
      projectName: project?.name ?? params.projectId,
    };

    eventBus.publish(params.projectId, 'member_added', eventPayload);
    // Mirror to the new member's personal channel — their existing SSE stream
    // doesn't subscribe to this project yet (they were just added), so without
    // this they'd only learn about the new project on next page reload.
    eventBus.publishToUser(member.name, 'member_added', params.projectId, eventPayload);
    dispatchWebhooks(params.projectId, 'member_added', eventPayload);

    if (member.type === 'human') {
      const projectName = project?.name ?? params.projectId;
      const mailBody = [
        `${auth.userName} has added you to project "${projectName}" as ${member.role}.`,
        '',
        'Log in to PlanSync to view the project.',
      ].join('\n');
      const ok = sendMail(
        [userEmail(member.name)],
        `[PlanSync] You've been added to "${projectName}"`,
        mailBody,
      );
      if (!ok)
        logger.warn(
          { projectId: params.projectId, member: member.name },
          'Failed to send member notification email',
        );
    }

    return NextResponse.json({ data: member }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

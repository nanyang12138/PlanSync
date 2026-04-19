import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { createMemberSchema } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';

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

    return NextResponse.json({ data: member }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

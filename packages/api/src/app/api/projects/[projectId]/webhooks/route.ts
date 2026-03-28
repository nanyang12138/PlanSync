import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';

type Params = { params: { projectId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');

    const webhooks = await prisma.webhook.findMany({
      where: { projectId: params.projectId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        projectId: true,
        url: true,
        events: true,
        active: true,
        createdBy: true,
        createdAt: true,
      },
    });

    return NextResponse.json({ data: webhooks });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId, 'owner');
    const body = await req.json();
    const { url, events, secret } = body as { url?: string; events?: string[]; secret?: string };

    if (!url || typeof url !== 'string') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'url is required');
    }
    if (
      !Array.isArray(events) ||
      events.length === 0 ||
      !events.every((e) => typeof e === 'string')
    ) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'events must be a non-empty string array');
    }

    const webhook = await prisma.webhook.create({
      data: {
        projectId: params.projectId,
        url,
        events,
        secret: secret ?? null,
        createdBy: auth.userName,
      },
    });

    return NextResponse.json(
      {
        data: {
          id: webhook.id,
          projectId: webhook.projectId,
          url: webhook.url,
          events: webhook.events,
          active: webhook.active,
          createdBy: webhook.createdBy,
          createdAt: webhook.createdAt,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

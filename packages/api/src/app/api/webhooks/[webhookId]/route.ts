import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';

type Params = { params: { webhookId: string } };

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    const webhook = await prisma.webhook.findUnique({ where: { id: params.webhookId } });
    if (!webhook) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Webhook not found');
    }
    await requireProjectRole(auth, webhook.projectId, 'owner');

    await prisma.webhook.delete({ where: { id: params.webhookId } });
    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    return handleApiError(error);
  }
}

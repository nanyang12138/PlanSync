import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { deliverWithRetry } from '@/lib/webhook';
import { formatSlackMessage, isSlackUrl } from '@/lib/slack-formatter';

type Params = { params: { webhookId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    const webhook = await prisma.webhook.findUnique({
      where: { id: params.webhookId },
      include: { project: true },
    });
    if (!webhook) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Webhook not found');
    }
    await requireProjectRole(auth, webhook.projectId, 'owner');

    const projectName = webhook.project.name;
    const data = { projectId: webhook.projectId, test: true };
    const timestamp = new Date().toISOString();

    const payload = isSlackUrl(webhook.url)
      ? {
          event: 'webhook.test',
          body: { blocks: formatSlackMessage('webhook.test', projectName, data) },
        }
      : {
          event: 'webhook.test',
          body: {
            event: 'webhook.test',
            projectId: webhook.projectId,
            projectName,
            data: { test: true },
            timestamp,
          },
        };

    await deliverWithRetry(webhook.id, webhook.url, webhook.secret, payload);

    return NextResponse.json({ data: { sent: true } });
  } catch (error) {
    return handleApiError(error);
  }
}

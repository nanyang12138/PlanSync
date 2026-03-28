import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { logger } from './logger';
import { formatSlackMessage, isSlackUrl } from './slack-formatter';

export type WebhookDeliverPayload = {
  event: string;
  body: Record<string, unknown>;
};

const RETRY_DELAYS_MS = [0, 1000, 5000, 30000];
const USER_AGENT = 'PlanSync-Webhooks/1.0';
const FETCH_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Delivers a webhook with retries (0s, 1s, 5s, 30s between attempts).
 * Records each HTTP attempt in WebhookDelivery. Stops on first 2xx response.
 */
export async function deliverWithRetry(
  webhookId: string,
  url: string,
  secret: string | null | undefined,
  payload: WebhookDeliverPayload,
): Promise<void> {
  const { event: eventName, body } = payload;
  const bodyStr = JSON.stringify(body);
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 0);
    }

    const deliveryId = crypto.randomUUID();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'X-PlanSync-Event': eventName,
      'X-PlanSync-Delivery': deliveryId,
    };

    if (secret) {
      const sig = crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
      headers['X-PlanSync-Signature'] = `sha256=${sig}`;
    }

    let responseCode = 0;
    let success = false;
    let errorMessage: string | null = null;

    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: bodyStr,
      });
      responseCode = res.status;
      success = res.ok;
      if (!success) {
        const text = await res.text().catch(() => '');
        errorMessage = `HTTP ${responseCode}${text ? `: ${text.slice(0, 500)}` : ''}`;
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    await prisma.webhookDelivery.create({
      data: {
        id: deliveryId,
        webhookId,
        event: eventName,
        requestBody: JSON.parse(bodyStr) as Prisma.InputJsonValue,
        responseCode,
        success,
        errorMessage: success ? null : errorMessage,
        attempt,
      },
    });

    if (success) return;
  }
}

async function dispatchWebhooksInternal(
  projectId: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  const webhooks = await prisma.webhook.findMany({
    where: {
      projectId,
      active: true,
      events: { has: event },
    },
  });
  if (webhooks.length === 0) return;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  const projectName = project?.name ?? projectId;
  const timestamp = new Date().toISOString();
  const dataWithProject: Record<string, unknown> = { ...data, projectId };

  const standardBody: Record<string, unknown> = {
    event,
    projectId,
    projectName,
    data,
    timestamp,
  };

  for (const wh of webhooks) {
    const slack = isSlackUrl(wh.url);
    const payload: WebhookDeliverPayload = slack
      ? {
          event,
          body: { blocks: formatSlackMessage(event, projectName, dataWithProject) },
        }
      : { event, body: standardBody };

    void deliverWithRetry(wh.id, wh.url, wh.secret, payload).catch((err) =>
      logger.error({ err, webhookId: wh.id, event }, 'deliverWithRetry failed'),
    );
  }
}

/** Fire-and-forget: loads matching webhooks and dispatches in the background. */
export function dispatchWebhooks(
  projectId: string,
  event: string,
  data: Record<string, unknown>,
): void {
  void dispatchWebhooksInternal(projectId, event, data).catch((err) =>
    logger.error({ err, projectId, event }, 'dispatchWebhooksInternal failed'),
  );
}

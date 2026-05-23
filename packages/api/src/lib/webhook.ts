import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { logger } from './logger';
import { formatSlackMessage, isSlackUrl } from './slack-formatter';

export type WebhookDeliverPayload = {
  event: string;
  body: Record<string, unknown>;
};

// R-139: retry-delay table is shared between the legacy inline retry path
// (`deliverWithRetry`) and the persistent-queue worker
// (`webhook-worker.ts`). Keeping a single source of truth means the two
// paths can never disagree about the back-off schedule (0s / 1s / 5s /
// 30s between successive attempts).
export const WEBHOOK_RETRY_DELAYS_MS = [0, 1000, 5000, 30000] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length;
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
 * R-139: feature-flag gate for the persistent webhook queue introduced by
 * R-139. When enabled, `dispatchWebhooks` inserts one durable
 * `webhook_jobs` row per matched webhook and a dedicated worker
 * (`webhook-worker.ts`) is the only thing that performs HTTP. When
 * disabled, the legacy in-memory `deliverWithRetry` path is used so
 * existing deployments behave exactly as they did before R-139.
 *
 * Read at every call site (not cached) so operators can flip the flag
 * with a config change + worker restart, no API restart required.
 */
export function isWebhookQueueEnabled(): boolean {
  return process.env.PLANSYNC_WEBHOOK_QUEUE === 'true';
}

export type WebhookHttpResult = {
  responseCode: number;
  success: boolean;
  errorMessage: string | null;
};

/**
 * R-139: send a single HTTP POST with the standard PlanSync webhook
 * headers (HMAC signature when `secret` is set, content-type, event +
 * delivery UUID). Returned status mirrors what `deliverWithRetry` would
 * persist on a `WebhookDelivery` row so the queue worker and the legacy
 * inline path share the same on-the-wire contract.
 *
 * The function never throws — transport errors are returned as
 * `success: false` with `errorMessage` set, so callers can record an
 * attempt row even when the receiver was unreachable.
 */
export async function postWebhook(
  url: string,
  secret: string | null | undefined,
  event: string,
  deliveryId: string,
  bodyStr: string,
): Promise<WebhookHttpResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'X-PlanSync-Event': event,
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

  return { responseCode, success, errorMessage };
}

/**
 * Delivers a webhook with retries (0s, 1s, 5s, 30s between attempts).
 * Records each HTTP attempt in WebhookDelivery. Stops on first 2xx response.
 *
 * This is the *legacy* in-memory retry path. R-139 introduces a durable
 * queue that survives process restarts; new code should prefer
 * `dispatchWebhooks` (which routes to the queue when
 * `PLANSYNC_WEBHOOK_QUEUE=true`) over calling `deliverWithRetry`
 * directly. The function is preserved for the on-demand "test webhook"
 * route (`POST /api/webhooks/[webhookId]/test`) where a synchronous
 * answer is the entire point of the call.
 */
export async function deliverWithRetry(
  webhookId: string,
  url: string,
  secret: string | null | undefined,
  payload: WebhookDeliverPayload,
): Promise<void> {
  const { event: eventName, body } = payload;
  const bodyStr = JSON.stringify(body);

  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await sleep(WEBHOOK_RETRY_DELAYS_MS[attempt - 1] ?? 0);
    }

    const deliveryId = crypto.randomUUID();
    const { responseCode, success, errorMessage } = await postWebhook(
      url,
      secret,
      eventName,
      deliveryId,
      bodyStr,
    );

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

/**
 * R-139: build the per-webhook payload for an outgoing event. Extracted
 * so the legacy inline dispatcher and the new persistent-queue
 * dispatcher cannot drift apart on the body format (Slack receivers see
 * formatted blocks, generic receivers see the standard envelope).
 */
function buildWebhookPayload(
  webhookUrl: string,
  event: string,
  projectId: string,
  projectName: string,
  data: Record<string, unknown>,
  timestamp: string,
): WebhookDeliverPayload {
  const slack = isSlackUrl(webhookUrl);
  const dataWithProject: Record<string, unknown> = { ...data, projectId };
  if (slack) {
    return {
      event,
      body: { blocks: formatSlackMessage(event, projectName, dataWithProject) },
    };
  }
  return {
    event,
    body: {
      event,
      projectId,
      projectName,
      data,
      timestamp,
    },
  };
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

  // R-139: queue path. One durable INSERT per matched webhook is enough —
  // the worker drives the retry schedule from `next_attempt_at` so even
  // a hard crash between this loop and the next HTTP attempt does not
  // lose work. We do not perform HTTP inline in this branch: that's the
  // whole point of the queue.
  if (isWebhookQueueEnabled()) {
    for (const wh of webhooks) {
      const payload = buildWebhookPayload(wh.url, event, projectId, projectName, data, timestamp);
      try {
        await prisma.webhookJob.create({
          data: {
            webhookId: wh.id,
            event,
            body: payload.body as Prisma.InputJsonValue,
            attempt: 0,
            status: 'pending',
            nextAttemptAt: new Date(),
          },
        });
      } catch (err) {
        logger.error(
          { err, webhookId: wh.id, event },
          'R-139: failed to enqueue webhook job (queue mode)',
        );
      }
    }
    return;
  }

  // Legacy path — kept verbatim so existing deployments that haven't
  // opted into the queue continue to behave exactly as they did before
  // R-139.
  for (const wh of webhooks) {
    const payload = buildWebhookPayload(wh.url, event, projectId, projectName, data, timestamp);
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

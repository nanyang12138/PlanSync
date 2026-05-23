/**
 * R-139: persistent-queue webhook worker.
 *
 * Before R-139, `deliverWithRetry` carried the entire 0s/1s/5s/30s
 * back-off in process memory via chained `setTimeout`s. An API restart
 * between attempts silently dropped every pending retry — the
 * `WebhookDelivery` row was never written and the receiver was never
 * notified, even though the foreground call to `dispatchWebhooks` had
 * already returned (fire-and-forget). This worker replaces that
 * schedule with one durable `webhook_jobs` row per webhook-event, so a
 * process restart loses at most the single in-flight HTTP request.
 *
 * Lifecycle:
 *   - `startWebhookWorker()` schedules a 1s tick. Each tick pulls the
 *     next batch of `status='pending' AND next_attempt_at <= now()`
 *     rows, atomically claims them by flipping status to `in_flight`,
 *     and sends HTTP outside the claiming transaction (so a slow
 *     receiver cannot hold a row lock).
 *   - On success the row becomes `delivered` (terminal).
 *   - On failure the row either reschedules with `next_attempt_at`
 *     bumped by the matching back-off slot, or — after
 *     `WEBHOOK_MAX_ATTEMPTS` attempts — becomes `failed` (terminal).
 *
 * Concurrency:
 *   The per-row claim uses a conditional `updateMany` filtered on
 *   `status='pending'`. Postgres reports `count: 1` exactly once across
 *   competing workers, so multiple worker processes can run safely
 *   (only the winner of each row proceeds to HTTP). No advisory lock is
 *   required for correctness; the scanner stays cheap and lockless.
 *
 * Feature flag:
 *   The worker tick only fires when `PLANSYNC_WEBHOOK_QUEUE=true`. The
 *   dispatcher honours the same flag, so flipping it off again is a
 *   clean rollback: new events take the legacy in-memory retry path
 *   immediately and the worker quietly stops claiming rows.
 */
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { logger } from './logger';
import {
  isWebhookQueueEnabled,
  postWebhook,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
} from './webhook';

const SCAN_INTERVAL_MS = 1000;
const DEFAULT_BATCH_LIMIT = 50;

let timer: ReturnType<typeof setInterval> | null = null;
let scanning = false;

export type WebhookWorkerScanResult = {
  /** Rows the worker successfully claimed and processed this tick. */
  processed: number;
  /** Of `processed`, rows that ended in `delivered`. */
  delivered: number;
  /** Of `processed`, rows that ended in `failed` (terminal). */
  failed: number;
  /** Of `processed`, rows requeued for a later attempt. */
  rescheduled: number;
};

const EMPTY_RESULT: WebhookWorkerScanResult = {
  processed: 0,
  delivered: 0,
  failed: 0,
  rescheduled: 0,
};

/**
 * Process one batch of due `webhook_jobs` rows. Exported for tests and
 * for ad-hoc operator scripts; the scheduled loop in
 * `startWebhookWorker` just calls this in a setInterval.
 *
 * `now` and `limit` are injectable so tests can pin a deterministic
 * clock and bound the batch.
 */
export async function processPendingWebhookJobs(
  opts: { now?: Date; limit?: number } = {},
): Promise<WebhookWorkerScanResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? DEFAULT_BATCH_LIMIT;

  const candidates = await prisma.webhookJob.findMany({
    where: { status: 'pending', nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take: limit,
  });
  if (candidates.length === 0) return EMPTY_RESULT;

  const result: WebhookWorkerScanResult = { processed: 0, delivered: 0, failed: 0, rescheduled: 0 };

  for (const job of candidates) {
    // R-139: conditional claim. If another worker process already
    // flipped this row to `in_flight` between our SELECT and UPDATE,
    // `count` will be 0 and we silently skip — the other worker owns
    // this attempt. No advisory lock or row-level lock is required.
    const claim = await prisma.webhookJob.updateMany({
      where: { id: job.id, status: 'pending' },
      data: { status: 'in_flight' },
    });
    if (claim.count !== 1) continue;
    result.processed += 1;

    const webhook = await prisma.webhook.findUnique({ where: { id: job.webhookId } });
    if (!webhook || !webhook.active) {
      // R-139: parent webhook was deleted or paused after this job was
      // enqueued. We mark the job `failed` (terminal) so the worker
      // does not hot-loop on rows that can never succeed.
      await prisma.webhookJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          lastError: webhook
            ? 'webhook inactive at delivery time'
            : 'webhook deleted before delivery',
        },
      });
      result.failed += 1;
      continue;
    }

    const attempt = job.attempt + 1;
    const bodyStr = JSON.stringify(job.body);
    const deliveryId = crypto.randomUUID();
    const { responseCode, success, errorMessage } = await postWebhook(
      webhook.url,
      webhook.secret,
      job.event,
      deliveryId,
      bodyStr,
    );

    // R-139: every attempt records a WebhookDelivery row, matching the
    // legacy `deliverWithRetry` shape so the existing UI / API queries
    // over delivery history keep working without change.
    try {
      await prisma.webhookDelivery.create({
        data: {
          id: deliveryId,
          webhookId: job.webhookId,
          event: job.event,
          requestBody: job.body as Prisma.InputJsonValue,
          responseCode,
          success,
          errorMessage: success ? null : errorMessage,
          attempt,
        },
      });
    } catch (err) {
      logger.error(
        { err, jobId: job.id, attempt },
        'R-139: failed to persist webhook delivery row',
      );
    }

    if (success) {
      await prisma.webhookJob.update({
        where: { id: job.id },
        data: { status: 'delivered', attempt, lastError: null },
      });
      result.delivered += 1;
      continue;
    }

    if (attempt >= WEBHOOK_MAX_ATTEMPTS) {
      await prisma.webhookJob.update({
        where: { id: job.id },
        data: { status: 'failed', attempt, lastError: errorMessage },
      });
      result.failed += 1;
      continue;
    }

    // R-139: requeue. `WEBHOOK_RETRY_DELAYS_MS[attempt]` is the wait
    // *before the next* attempt (`attempt` is 1-indexed, so 1 -> the
    // 1s slot, 2 -> the 5s slot, 3 -> the 30s slot).
    const delayMs = WEBHOOK_RETRY_DELAYS_MS[attempt] ?? WEBHOOK_RETRY_DELAYS_MS.at(-1) ?? 30000;
    const nextAttemptAt = new Date(now.getTime() + delayMs);
    await prisma.webhookJob.update({
      where: { id: job.id },
      data: {
        status: 'pending',
        attempt,
        nextAttemptAt,
        lastError: errorMessage,
      },
    });
    result.rescheduled += 1;
  }

  if (result.processed > 0) {
    logger.info(
      {
        processed: result.processed,
        delivered: result.delivered,
        failed: result.failed,
        rescheduled: result.rescheduled,
      },
      'R-139: webhook-worker tick completed',
    );
  }

  return result;
}

/**
 * Start the periodic worker loop. Idempotent: a second call while a
 * timer is already running is a no-op (useful for dev hot-reload).
 * When `PLANSYNC_WEBHOOK_QUEUE` is unset the worker does not start and
 * logs why so operators can tell the difference between "worker
 * crashed" and "queue mode disabled".
 */
export function startWebhookWorker(): void {
  if (timer) return;
  if (!isWebhookQueueEnabled()) {
    logger.info(
      'R-139: webhook worker not started (PLANSYNC_WEBHOOK_QUEUE != "true"). Legacy in-memory retry path is in use.',
    );
    return;
  }
  timer = setInterval(() => {
    if (scanning) return;
    scanning = true;
    processPendingWebhookJobs()
      .catch((err) => logger.error({ err }, 'R-139: webhook-worker scan crashed'))
      .finally(() => {
        scanning = false;
      });
  }, SCAN_INTERVAL_MS);
  logger.info('R-139: webhook worker started (interval: 1s)');
}

export function stopWebhookWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('R-139: webhook worker stopped');
  }
}

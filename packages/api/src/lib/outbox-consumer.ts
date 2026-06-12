/**
 * R-162: outbox consumer.
 *
 * Drains `domain_events` rows where `delivered_at IS NULL` and dispatches
 * them to handler callbacks registered per `eventType`. Producers write
 * to the table via `outbox.emit(tx, ...)` (R-160). This module is the
 * other half of that contract — it owns the read side, the at-least-once
 * delivery guarantee, and the per-event handler dispatch interface that
 * R-163 (SSE relay), R-164 (webhook), R-165 (email), and R-166
 * (scanner state changes) will register against.
 *
 * Lifecycle:
 *   - `registerOutboxHandler(type, handler)` — adopt-once at startup.
 *     Calling twice for the same eventType throws (loud-fail rather
 *     than silently shadow the first handler).
 *   - `processPendingOutboxEvents({ limit, now })` — pull one batch and
 *     dispatch synchronously. Exported for tests + ad-hoc operator use.
 *   - `startOutboxConsumer()` — schedule `processPendingOutboxEvents`
 *     on a 1s interval. Idempotent. Off unless
 *     `PLANSYNC_OUTBOX_CONSUMER=true` so the legacy direct-publish path
 *     (event-bus, sendMail, dispatchWebhooks, createActivity) stays
 *     authoritative until R-161 migrates producers.
 *   - `stopOutboxConsumer()` — clear the timer.
 *
 * Concurrency:
 *   Multiple worker replicas can run safely. The per-row claim is a
 *   conditional `updateMany` filtered on `deliveredAt: null`; Postgres
 *   reports `count: 1` exactly once across competing workers, so only
 *   the winner of each row dispatches. No advisory lock required —
 *   identical pattern to `webhook-worker.ts` (R-139).
 *
 * Failure handling:
 *   A handler throw bumps the row's `attempt` counter but leaves
 *   `delivered_at` null so the next tick retries. There is no
 *   exponential back-off yet; R-163/R-164 will tighten this once the
 *   first real sinks land and we know what the realistic failure modes
 *   look like in practice. For now, "retry on every tick" is the
 *   correct posture for an additive scaffold.
 *
 * Telemetry:
 *   Each non-empty tick logs `{ processed, delivered, failed, skipped }`
 *   under the `R-162` tag so operators can confirm the consumer is
 *   draining the table.
 */
import { prisma } from './prisma';
import { logger } from './logger';
import type { DomainEventType, DomainEventPayload } from '@plansync/shared';

const SCAN_INTERVAL_MS = 1000;
const DEFAULT_BATCH_LIMIT = 50;

/**
 * Dispatch context handed to each registered handler. Carries the
 * already-validated envelope plus the row id so handlers can record
 * correlations (e.g. SSE `lastEventId`) without re-querying.
 */
export interface OutboxDispatch {
  /** `domain_events.id` (bigserial). */
  id: bigint;
  /** Re-typed payload — same shape `outbox.emit` accepted. */
  payload: DomainEventPayload;
  /** `domain_events.attempt` BEFORE this dispatch — 0 on first try. */
  priorAttempts: number;
}

export type OutboxHandler = (event: OutboxDispatch) => Promise<void> | void;

const handlers = new Map<DomainEventType, OutboxHandler>();

export function registerOutboxHandler(type: DomainEventType, handler: OutboxHandler): void {
  if (handlers.has(type)) {
    throw new Error(`R-162: outbox handler for "${type}" is already registered`);
  }
  handlers.set(type, handler);
}

/** Test helper: forget every handler. Not exported from the package index. */
export function _resetOutboxHandlersForTests(): void {
  handlers.clear();
}

export function isOutboxConsumerEnabled(): boolean {
  return process.env.PLANSYNC_OUTBOX_CONSUMER === 'true';
}

export type OutboxScanResult = {
  /** Rows the consumer successfully claimed and dispatched this tick. */
  processed: number;
  /** Of `processed`, rows whose handler returned success. */
  delivered: number;
  /** Of `processed`, rows whose handler threw — `attempt` was bumped. */
  failed: number;
  /** Rows seen but skipped (no handler registered for the eventType). */
  skipped: number;
};

const EMPTY_RESULT: OutboxScanResult = { processed: 0, delivered: 0, failed: 0, skipped: 0 };

export async function processPendingOutboxEvents(
  opts: { now?: Date; limit?: number } = {},
): Promise<OutboxScanResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? DEFAULT_BATCH_LIMIT;

  const candidates = await prisma.domainEvent.findMany({
    where: { deliveredAt: null },
    orderBy: { id: 'asc' },
    take: limit,
  });
  if (candidates.length === 0) return EMPTY_RESULT;

  const result: OutboxScanResult = { processed: 0, delivered: 0, failed: 0, skipped: 0 };

  for (const row of candidates) {
    const handler = handlers.get(row.eventType as DomainEventType);
    if (!handler) {
      // No handler registered for this eventType — leave the row
      // undelivered so a later boot can pick it up once R-163-166 wires
      // the missing sink. The `skipped` counter surfaces this in logs.
      result.skipped += 1;
      continue;
    }

    // R-162: conditional claim mirrors R-139 webhook-worker. If another
    // replica already flipped this row's deliveredAt, count is 0 and we
    // silently skip — the other replica owns this dispatch.
    const claim = await prisma.domainEvent.updateMany({
      where: { id: row.id, deliveredAt: null },
      data: { attempt: { increment: 1 } },
    });
    if (claim.count !== 1) continue;
    result.processed += 1;

    try {
      await handler({
        id: row.id,
        payload: row.payload as unknown as DomainEventPayload,
        priorAttempts: row.attempt,
      });
      await prisma.domainEvent.update({
        where: { id: row.id },
        data: { deliveredAt: now },
      });
      result.delivered += 1;
    } catch (err) {
      logger.error(
        { err, eventId: row.id.toString(), eventType: row.eventType },
        'R-162: outbox handler threw; leaving row undelivered for retry',
      );
      result.failed += 1;
    }
  }

  if (result.processed > 0 || result.skipped > 0) {
    logger.info(
      {
        processed: result.processed,
        delivered: result.delivered,
        failed: result.failed,
        skipped: result.skipped,
      },
      'R-162: outbox-consumer tick completed',
    );
  }

  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let scanning = false;

export function startOutboxConsumer(): void {
  if (timer) return;
  if (!isOutboxConsumerEnabled()) {
    logger.info(
      'R-162: outbox consumer not started (PLANSYNC_OUTBOX_CONSUMER != "true"). Legacy direct-publish paths remain authoritative.',
    );
    return;
  }
  timer = setInterval(() => {
    if (scanning) return;
    scanning = true;
    processPendingOutboxEvents()
      .catch((err) => logger.error({ err }, 'R-162: outbox-consumer scan crashed'))
      .finally(() => {
        scanning = false;
      });
  }, SCAN_INTERVAL_MS);
  logger.info('R-162: outbox consumer started (interval: 1s)');
}

export function stopOutboxConsumer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('R-162: outbox consumer stopped');
  }
}

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
 * Concurrency (R-208 + R-209):
 *   Multiple worker replicas can run safely. Each row is claimed in two
 *   layers:
 *     1. CAS on `attempt` (R-208) — the claim `updateMany` filters on the
 *        exact `attempt` it read and increments it, so two workers racing the
 *        SAME read produce exactly one `count: 1`. (A plain `deliveredAt: null`
 *        filter is NOT exclusive — incrementing attempt does not change that
 *        predicate, so both racers would win.)
 *     2. Visibility lease (R-209) — on claim the winner stamps
 *        `lockedUntil = now + OUTBOX_LEASE_MS` and a fresh `claimToken`. The
 *        scan skips rows whose lease is still in the future, so a row that is
 *        in flight on one worker is invisible to the others until either the
 *        handler settles it or the lease expires (worker crash recovery).
 *        Every terminal write is guarded by `claimToken`, so a slow worker
 *        whose lease lapsed and was taken over cannot write a stale terminal
 *        state over the new owner's result.
 *   No advisory lock required — same family as `webhook-worker.ts` (R-139),
 *   but lease-with-expiry recovers crashed claims that R-139's permanent
 *   `in_flight` flag would strand.
 *
 * Failure handling:
 *   A handler throw bumps the row's `attempt` counter, clears the lease, and
 *   leaves `delivered_at` null so the next tick retries — until
 *   `OUTBOX_MAX_ATTEMPTS`, after which the row is dead-lettered (failedAt +
 *   lastError, R-208). There is no exponential back-off yet; R-163/R-164 will
 *   tighten this once the first real sinks land and we know what the realistic
 *   failure modes look like in practice.
 *
 * Telemetry:
 *   Each non-empty tick logs `{ processed, delivered, failed, skipped }`
 *   under the `R-162` tag so operators can confirm the consumer is
 *   draining the table.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from './prisma';
import { logger } from './logger';
import type { DomainEventType, DomainEventPayload } from '@plansync/shared';

const SCAN_INTERVAL_MS = 1000;
const DEFAULT_BATCH_LIMIT = 50;

// R-208: dead-letter cap. After this many failed dispatch attempts the consumer
// gives up on a row (sets failedAt + lastError) instead of retrying forever.
// Mirrors R-139's WEBHOOK_MAX_ATTEMPTS so the two queues behave consistently.
const OUTBOX_MAX_ATTEMPTS = 4;

// R-209: how long a claim owns a row before its lease is considered expired and
// the row becomes re-claimable by another worker. Must comfortably exceed the
// slowest realistic handler so a healthy worker is never pre-empted mid-flight;
// kept short enough that a crashed worker's row recovers within a minute. The
// in-process `scanning` guard already serializes ticks within one worker, so
// this only matters across worker replicas.
const OUTBOX_LEASE_MS = 60_000;

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
  /** Of `processed`, rows whose handler threw and will be retried next tick. */
  failed: number;
  /**
   * R-208: of `processed`, rows whose handler threw on the OUTBOX_MAX_ATTEMPTS-th
   * attempt — marked failed (failedAt + lastError) and no longer retried.
   */
  deadLettered: number;
  /** Rows seen but skipped (no handler registered for the eventType). */
  skipped: number;
  /**
   * R-208: distinct eventTypes present in this tick's candidate window.
   * Observability only — lets operators confirm which event types the consumer
   * is actually draining without grepping logs.
   */
  scannedTypes: string[];
};

const EMPTY_RESULT: OutboxScanResult = {
  processed: 0,
  delivered: 0,
  failed: 0,
  deadLettered: 0,
  skipped: 0,
  scannedTypes: [],
};

export async function processPendingOutboxEvents(
  opts: { now?: Date; limit?: number; tokenFactory?: () => string } = {},
): Promise<OutboxScanResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? DEFAULT_BATCH_LIMIT;
  // R-209: the lease this tick's claims will hold, and the token generator.
  // `tokenFactory` is injectable so unit tests can assert deterministic tokens
  // (production uses crypto.randomUUID, which is non-deterministic by design).
  const leaseUntil = new Date(now.getTime() + OUTBOX_LEASE_MS);
  const newToken = opts.tokenFactory ?? randomUUID;

  // R-192: only scan event types we actually have a handler for.
  //
  // Some event types are *query-only facts*, not work items:
  // `github_pull_request` / `github_pull_request_review` are written by the
  // webhook receiver purely so `deriveTaskCompletionState` can read them
  // back via SQL. No consumer ever "delivers" them, so their
  // `deliveredAt` stays null forever by design.
  //
  // The candidate window is a fixed `take: limit` ordered by `id ASC`. If
  // those never-delivered fact rows were allowed into the window they would
  // re-fill the same lowest-id slots every tick and starve the
  // `github_push` rows behind them (head-of-line blocking) — the consumer
  // would spin without ever reaching the events it can actually process.
  //
  // Pre-filtering on the registered handler set keeps the window full of
  // *deliverable* rows only. Fact rows remain queryable; they just never
  // occupy a delivery slot. If a handler for one of them is registered
  // later, its older rows naturally re-enter the scan — nothing is lost.
  const registeredTypes = Array.from(handlers.keys());
  if (registeredTypes.length === 0) return EMPTY_RESULT;

  const candidates = await prisma.domainEvent.findMany({
    // R-208: exclude dead-lettered rows (failedAt set) from the working set —
    // a row that gave up must not re-enter the scan window and starve others.
    // R-209: also exclude rows whose lease is still live (lockedUntil in the
    // future) — another worker is mid-flight on them. A null or already-expired
    // lease is fair game (fresh row, or the previous claimant crashed).
    where: {
      deliveredAt: null,
      failedAt: null,
      eventType: { in: registeredTypes },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    orderBy: { id: 'asc' },
    take: limit,
  });
  if (candidates.length === 0) return EMPTY_RESULT;

  const result: OutboxScanResult = {
    processed: 0,
    delivered: 0,
    failed: 0,
    deadLettered: 0,
    skipped: 0,
    scannedTypes: [...new Set(candidates.map((c) => c.eventType))],
  };

  for (const row of candidates) {
    const handler = handlers.get(row.eventType as DomainEventType);
    if (!handler) {
      // Defensive only: the query already pre-filters to `registeredTypes`,
      // so in practice this branch is unreachable in production (handlers
      // are registered once at startup and never removed). It survives to
      // cover the test-reset path (`_resetOutboxHandlersForTests`) and any
      // future race where a handler set changes between query and dispatch.
      // `skipped` therefore reads ~0 now; it is no longer the signal for
      // "you forgot to register a handler" — that lives in a future
      // health-check, not in the hot loop.
      result.skipped += 1;
      continue;
    }

    // R-208 + R-209: exclusive claim = CAS on `attempt` AND lease acquisition.
    //
    // R-208 (`attempt: row.attempt` + increment) makes two workers racing the
    // SAME read mutually exclusive: only the one whose read matches the current
    // attempt wins; the loser's predicate no longer matches → count 0 → skip.
    //
    // R-209 closes the *sequential* re-claim gap: a second worker re-reading
    // the row on a LATER tick while our handler is still running. We stamp a
    // fresh `claimToken` (this dispatch's ownership proof) and
    // `lockedUntil = now + lease`. The OR clause means we only acquire a row
    // whose lease is null or already expired, mirroring the scan filter so a
    // racer cannot steal a still-live lease between scan and claim.
    const token = newToken();
    const claim = await prisma.domainEvent.updateMany({
      where: {
        id: row.id,
        deliveredAt: null,
        failedAt: null,
        attempt: row.attempt,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: { attempt: { increment: 1 }, lockedUntil: leaseUntil, claimToken: token },
    });
    if (claim.count !== 1) continue;
    result.processed += 1;

    // Every terminal / observability write below is a guarded `updateMany`
    // keyed on `claimToken: token` (plus deliveredAt/failedAt null), never an
    // unconditional `update`. If our lease expired mid-handler and another
    // worker took the row over, its claim rewrote `claimToken`, so our write
    // matches 0 rows — we neither corrupt the new owner's result nor
    // double-count the stat. A row therefore can never end up with both
    // deliveredAt and failedAt set, nor be settled twice.
    try {
      await handler({
        id: row.id,
        payload: row.payload as unknown as DomainEventPayload,
        priorAttempts: row.attempt,
      });
      const settled = await prisma.domainEvent.updateMany({
        where: { id: row.id, claimToken: token, deliveredAt: null, failedAt: null },
        data: { deliveredAt: now, lastError: null, lockedUntil: null, claimToken: null },
      });
      if (settled.count === 1) result.delivered += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The claim above incremented `attempt`, so this dispatch is attempt
      // number `row.attempt + 1` (1-indexed).
      const attemptsSoFar = row.attempt + 1;
      if (attemptsSoFar >= OUTBOX_MAX_ATTEMPTS) {
        // R-208: give up. Mark the row dead-lettered (failedAt + lastError) so
        // it leaves the pending working set and the consumer stops retrying it
        // — a permanently-broken event can no longer sit at the head of the
        // id-ASC scan window and starve newer rows. Mirrors the R-139
        // webhook-worker terminal state. R-209: guarded by claimToken + counted
        // only when we actually wrote (count === 1), so a lease we already lost
        // does not produce a phantom dead-letter stat.
        const deadLettered = await prisma.domainEvent.updateMany({
          where: { id: row.id, claimToken: token, deliveredAt: null, failedAt: null },
          data: {
            failedAt: now,
            lastError: message.slice(0, 1000),
            lockedUntil: null,
            claimToken: null,
          },
        });
        if (deadLettered.count === 1) {
          logger.error(
            {
              err,
              eventId: row.id.toString(),
              eventType: row.eventType,
              attempts: attemptsSoFar,
            },
            'R-208: outbox handler exhausted retries; dead-lettering row',
          );
          result.deadLettered += 1;
        }
      } else {
        // R-209: release the lease (lockedUntil/claimToken back to null) and
        // persist the latest error so the row is immediately re-scannable next
        // tick and operators can triage it without grepping logs. Guarded by
        // claimToken + counted only on count === 1 so a lost lease does not log
        // a phantom retry.
        const released = await prisma.domainEvent.updateMany({
          where: { id: row.id, claimToken: token, deliveredAt: null, failedAt: null },
          data: { lastError: message.slice(0, 1000), lockedUntil: null, claimToken: null },
        });
        if (released.count === 1) {
          logger.error(
            {
              err,
              eventId: row.id.toString(),
              eventType: row.eventType,
              attempts: attemptsSoFar,
            },
            'R-162: outbox handler threw; leaving row undelivered for retry',
          );
          result.failed += 1;
        }
      }
    }
  }

  if (result.processed > 0 || result.skipped > 0) {
    logger.info(
      {
        processed: result.processed,
        delivered: result.delivered,
        failed: result.failed,
        deadLettered: result.deadLettered,
        skipped: result.skipped,
        scannedTypes: result.scannedTypes,
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

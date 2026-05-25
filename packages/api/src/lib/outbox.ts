import type { Prisma, PrismaClient } from '@prisma/client';
import {
  domainEventPayloadSchema,
  type DomainEventPayload,
  type DomainEventType,
} from '@plansync/shared';
import { prisma } from './prisma';
import { logger } from './logger';

/**
 * R-160: transactional outbox writer.
 *
 * Producers call `outbox.emit(tx, type, { projectId?, userName?, data })`
 * inside the same `prisma.$transaction(async (tx) => {...})` callback that
 * makes the state change. If the surrounding transaction rolls back, the
 * row vanishes with it — that is the whole point of an outbox versus a
 * post-commit `eventBus.publish`. A separate worker process (R-162) drains
 * `delivered_at IS NULL` rows and fans them out to the existing SSE,
 * webhook, email and activity sinks.
 *
 * The writer never silently drops events: if the payload fails schema
 * validation (`domainEventPayloadSchema` in @plansync/shared) `emit` throws
 * synchronously so the producing transaction aborts. A bad event in the
 * outbox would be worse than a missing one.
 *
 * Test ergonomics: in vitest we want to assert that a rolled-back tx leaves
 * the table empty. Because Prisma's `tx` argument is just a thin proxy
 * around a `PrismaClient`, we accept any `Prisma.TransactionClient | PrismaClient`
 * here — but the helper enforces, via the type signature on
 * `emitInTransaction`, that callers pass *something*.
 */
export type TxClient = Prisma.TransactionClient | PrismaClient;

export interface EmitInput {
  projectId?: string | null;
  userName?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Write one row to `domain_events` inside the given transaction. Throws on
 * validation failure so the producing transaction aborts cleanly.
 */
export async function emit(
  tx: TxClient,
  type: DomainEventType,
  input: EmitInput = {},
): Promise<void> {
  const envelope: DomainEventPayload = domainEventPayloadSchema.parse({
    type,
    projectId: input.projectId ?? null,
    userName: input.userName ?? null,
    data: input.data ?? {},
  });

  await tx.domainEvent.create({
    data: {
      eventType: envelope.type,
      projectId: envelope.projectId ?? null,
      userName: envelope.userName ?? null,
      // `payload` re-stores the full validated envelope (including `type`
      // itself) so the worker has a self-contained record per row and does
      // not have to rebuild it from `event_type` + sibling columns.
      payload: envelope as unknown as Prisma.InputJsonValue,
    },
  });
}

/**
 * R-161 escape hatch: when a producer absolutely cannot wrap its work in a
 * transaction (today: instrumentation startup hooks, dev-only seed scripts)
 * we still want the event in the outbox so the worker can pick it up. This
 * starts a 1-row transaction internally.
 *
 * Best-effort by design: the failure is logged but **swallowed**. Use this
 * ONLY when the call site has no recovery path — instrumentation hooks,
 * dev seeds. **Never** use it from request handlers; those must use either
 * `emit(tx, ...)` inside an existing transaction OR
 * {@link emitOutOfTxStrict} which surfaces failures so the HTTP response
 * accurately reports persistence success/failure.
 *
 * Closes #781 / #793 / #797 / #806 — the GitHub webhook receiver
 * previously called this helper and ended up returning 200 to GitHub even
 * when the outbox INSERT failed, silently dropping events that GitHub then
 * never retried. The receiver now uses `emitOutOfTxStrict`.
 */
export async function emitOutOfTx(type: DomainEventType, input: EmitInput = {}): Promise<void> {
  try {
    await emitOutOfTxStrict(type, input);
  } catch (err) {
    logger.error({ err, type }, 'outbox.emitOutOfTx failed');
  }
}

/**
 * Same as {@link emitOutOfTx} but rethrows on failure so the caller can
 * propagate the failure to its own response (e.g. webhook handlers
 * returning 5xx so GitHub retries; CLI seed scripts exiting non-zero).
 */
export async function emitOutOfTxStrict(
  type: DomainEventType,
  input: EmitInput = {},
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await emit(tx, type, input);
  });
}

export const outbox = {
  emit,
  emitOutOfTx,
  emitOutOfTxStrict,
};

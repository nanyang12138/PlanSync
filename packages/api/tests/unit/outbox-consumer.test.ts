/**
 * R-162: outbox-consumer unit tests.
 *
 * Mocks prisma so we don't need a live Postgres for these — the
 * consumer's contract is "claim, dispatch, mark delivered" and the
 * mock asserts each step. End-to-end behaviour against a real DB lives
 * in the R-163-166 sink PRs that exercise the consumer's outputs.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above all imports, so the mock objects must
// be declared via vi.hoisted to live in the same hoisted scope.
const mocks = vi.hoisted(() => ({
  domainEventFindMany: vi.fn(),
  domainEventUpdateMany: vi.fn(),
  domainEventUpdate: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    domainEvent: {
      findMany: mocks.domainEventFindMany,
      updateMany: mocks.domainEventUpdateMany,
      update: mocks.domainEventUpdate,
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  processPendingOutboxEvents,
  registerOutboxHandler,
  _resetOutboxHandlersForTests,
  isOutboxConsumerEnabled,
} from '@/lib/outbox-consumer';

beforeEach(() => {
  mocks.domainEventFindMany.mockReset();
  mocks.domainEventUpdateMany.mockReset();
  mocks.domainEventUpdate.mockReset();
  _resetOutboxHandlersForTests();
});

function row(id: bigint, eventType: string, attempt = 0) {
  return {
    id,
    eventType,
    projectId: 'p1',
    userName: null,
    payload: { type: eventType, projectId: 'p1', userName: null, data: { x: 1 } },
    createdAt: new Date('2026-05-29T00:00:00Z'),
    deliveredAt: null,
    attempt,
    failedAt: null,
    lastError: null,
    lockedUntil: null,
    claimToken: null,
  };
}

// R-209: deterministic token so claim / terminal assertions are stable
// (production uses crypto.randomUUID).
const TOK = 'tok-fixed';
const lease = (now: Date) => new Date(now.getTime() + 60_000);

describe('R-162: processPendingOutboxEvents', () => {
  it('returns the empty result when no rows are pending', async () => {
    registerOutboxHandler('plan_activated', () => {});
    mocks.domainEventFindMany.mockResolvedValue([]);
    const res = await processPendingOutboxEvents();
    expect(res).toEqual({
      processed: 0,
      delivered: 0,
      failed: 0,
      deadLettered: 0,
      skipped: 0,
      scannedTypes: [],
    });
    expect(mocks.domainEventUpdate).not.toHaveBeenCalled();
  });

  it('does not even query when no handlers are registered', async () => {
    // With zero handlers there is nothing this consumer can deliver, so it
    // must short-circuit BEFORE touching the DB — never pull a batch it
    // would only skip.
    const res = await processPendingOutboxEvents();
    expect(res).toEqual({
      processed: 0,
      delivered: 0,
      failed: 0,
      deadLettered: 0,
      skipped: 0,
      scannedTypes: [],
    });
    expect(mocks.domainEventFindMany).not.toHaveBeenCalled();
  });

  it('R-192 starvation guard: pre-filters the query to registered event types only', async () => {
    // The fix for head-of-line blocking. Query-only fact rows
    // (github_pull_request / _review) have no handler and live at
    // deliveredAt=null forever; if they entered the fixed id-ASC window
    // they would starve github_push behind them. The consumer must scope
    // the scan to event types it can actually deliver.
    registerOutboxHandler('github_push', () => {});
    mocks.domainEventFindMany.mockResolvedValue([]);

    await processPendingOutboxEvents();

    expect(mocks.domainEventFindMany).toHaveBeenCalledTimes(1);
    const where = mocks.domainEventFindMany.mock.calls[0][0].where;
    expect(where.deliveredAt).toBeNull();
    expect(where.eventType).toEqual({ in: ['github_push'] });
    // The never-handled fact types must NOT be in the scan set.
    expect(where.eventType.in).not.toContain('github_pull_request');
    expect(where.eventType.in).not.toContain('github_pull_request_review');
    // R-209: the scan must also skip rows with a live lease.
    expect(where.OR).toEqual([{ lockedUntil: null }, { lockedUntil: { lt: expect.any(Date) } }]);
  });

  it('dispatches, marks delivered, and reports counts on the happy path', async () => {
    const seen: bigint[] = [];
    registerOutboxHandler('plan_activated', (ev) => {
      seen.push(ev.id);
    });
    mocks.domainEventFindMany.mockResolvedValue([row(7n, 'plan_activated')]);
    mocks.domainEventUpdateMany.mockResolvedValue({ count: 1 });
    mocks.domainEventUpdate.mockResolvedValue({});

    const now = new Date('2026-05-29T12:00:00Z');
    const res = await processPendingOutboxEvents({ now, tokenFactory: () => TOK });
    expect(res).toEqual({
      processed: 1,
      delivered: 1,
      failed: 0,
      deadLettered: 0,
      skipped: 0,
      scannedTypes: ['plan_activated'],
    });
    expect(seen).toEqual([7n]);
    // R-208 + R-209: claim is an exclusive CAS on attempt AND a lease acquire —
    // it stamps lockedUntil + claimToken and only matches a free/expired lease.
    expect(mocks.domainEventUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 7n,
        deliveredAt: null,
        failedAt: null,
        attempt: 0,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: { attempt: { increment: 1 }, lockedUntil: lease(now), claimToken: TOK },
    });
    // Success is a guarded updateMany keyed on claimToken (not an unconditional
    // update): sets deliveredAt, clears lastError + the lease, never overwriting
    // a terminal row or one owned by another worker.
    expect(mocks.domainEventUpdateMany).toHaveBeenCalledWith({
      where: { id: 7n, claimToken: TOK, deliveredAt: null, failedAt: null },
      data: { deliveredAt: now, lastError: null, lockedUntil: null, claimToken: null },
    });
    expect(mocks.domainEventUpdate).not.toHaveBeenCalled();
  });

  it('R-209: does NOT count delivery when the terminal write loses the lease', async () => {
    // Lease expired mid-handler and another worker took the row over (rewrote
    // claimToken). Our claim still succeeded (count 1) and the handler ran, but
    // the guarded terminal updateMany matches 0 rows → we must NOT increment
    // `delivered`, or the stat / log would over-report.
    registerOutboxHandler('plan_activated', () => {});
    mocks.domainEventFindMany.mockResolvedValue([row(8n, 'plan_activated')]);
    // 1st updateMany = claim (won); 2nd = terminal (lost, count 0).
    mocks.domainEventUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const now = new Date('2026-05-29T12:00:00Z');
    const res = await processPendingOutboxEvents({ now, tokenFactory: () => TOK });
    expect(res).toEqual({
      processed: 1,
      delivered: 0,
      failed: 0,
      deadLettered: 0,
      skipped: 0,
      scannedTypes: ['plan_activated'],
    });
  });

  it('R-208: exclusive CAS claim skips when another worker won the race', async () => {
    registerOutboxHandler('plan_activated', () => {});
    mocks.domainEventFindMany.mockResolvedValue([row(9n, 'plan_activated', 2)]);
    // count: 0 ⇒ the CAS lost: another worker already bumped attempt (or the
    // row was delivered / dead-lettered / leased) since our read.
    mocks.domainEventUpdateMany.mockResolvedValue({ count: 0 });

    const now = new Date('2026-05-29T12:00:00Z');
    const res = await processPendingOutboxEvents({ now, tokenFactory: () => TOK });
    expect(res.processed).toBe(0);
    // The claim is a compare-and-swap + lease acquire: id + deliveredAt:null +
    // failedAt:null + the exact attempt we read + a free/expired lease. Only
    // one racer can match.
    expect(mocks.domainEventUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 9n,
        deliveredAt: null,
        failedAt: null,
        attempt: 2,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: { attempt: { increment: 1 }, lockedUntil: lease(now), claimToken: TOK },
    });
    // Lost the claim → only the claim updateMany ran, no terminal write.
    expect(mocks.domainEventUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.domainEventUpdate).not.toHaveBeenCalled();
  });

  it('counts a handler throw as failed and leaves the row undelivered', async () => {
    registerOutboxHandler('plan_activated', () => {
      throw new Error('handler boom');
    });
    mocks.domainEventFindMany.mockResolvedValue([row(11n, 'plan_activated')]);
    mocks.domainEventUpdateMany.mockResolvedValue({ count: 1 });

    const now = new Date('2026-05-29T12:00:00Z');
    const res = await processPendingOutboxEvents({ now, tokenFactory: () => TOK });
    expect(res).toEqual({
      processed: 1,
      delivered: 0,
      failed: 1,
      deadLettered: 0,
      skipped: 0,
      scannedTypes: ['plan_activated'],
    });
    // `attempt` was bumped via the claim, but neither deliveredAt nor failedAt
    // was set (attempt 1 < OUTBOX_MAX_ATTEMPTS) — the next tick will retry.
    expect(mocks.domainEventUpdate).not.toHaveBeenCalled();
    // R-208 + R-209: the latest error is persisted every attempt and the lease
    // is released (lockedUntil/claimToken back to null) so the row is
    // immediately re-scannable. Guarded on claimToken.
    expect(mocks.domainEventUpdateMany).toHaveBeenCalledWith({
      where: { id: 11n, claimToken: TOK, deliveredAt: null, failedAt: null },
      data: { lastError: 'handler boom', lockedUntil: null, claimToken: null },
    });
  });

  it('R-208: dead-letters a row once it reaches OUTBOX_MAX_ATTEMPTS', async () => {
    registerOutboxHandler('plan_activated', () => {
      throw new Error('handler boom');
    });
    // attempt=3 means this dispatch is the 4th attempt (OUTBOX_MAX_ATTEMPTS).
    mocks.domainEventFindMany.mockResolvedValue([row(12n, 'plan_activated', 3)]);
    mocks.domainEventUpdateMany.mockResolvedValue({ count: 1 });
    mocks.domainEventUpdate.mockResolvedValue({});

    const now = new Date('2026-06-11T12:00:00Z');
    const res = await processPendingOutboxEvents({ now, tokenFactory: () => TOK });

    expect(res).toEqual({
      processed: 1,
      delivered: 0,
      failed: 0,
      deadLettered: 1,
      skipped: 0,
      scannedTypes: ['plan_activated'],
    });
    // The row is marked failed (dead-lettered) via a guarded updateMany keyed on
    // claimToken: failedAt + lastError set and the lease cleared, so it leaves
    // the pending working set and is never retried — and only when we still own
    // the lease (count === 1).
    expect(mocks.domainEventUpdateMany).toHaveBeenCalledWith({
      where: { id: 12n, claimToken: TOK, deliveredAt: null, failedAt: null },
      data: { failedAt: now, lastError: 'handler boom', lockedUntil: null, claimToken: null },
    });
    expect(mocks.domainEventUpdate).not.toHaveBeenCalled();
  });

  it('R-208 + R-209: the scan query excludes delivered, dead-lettered AND live-leased rows', async () => {
    registerOutboxHandler('plan_activated', () => {});
    mocks.domainEventFindMany.mockResolvedValue([]);

    const now = new Date('2026-05-29T12:00:00Z');
    await processPendingOutboxEvents({ now });

    const where = mocks.domainEventFindMany.mock.calls[0][0].where;
    expect(where.deliveredAt).toBeNull();
    expect(where.failedAt).toBeNull();
    // R-209: null lease (fresh) or expired lease (lockedUntil < now) only.
    expect(where.OR).toEqual([{ lockedUntil: null }, { lockedUntil: { lt: now } }]);
  });

  it('rejects double-registration of a handler for the same eventType', () => {
    registerOutboxHandler('plan_activated', () => {});
    expect(() => registerOutboxHandler('plan_activated', () => {})).toThrow(/already registered/);
  });
});

describe('R-162: isOutboxConsumerEnabled', () => {
  it('only returns true when PLANSYNC_OUTBOX_CONSUMER is exactly "true"', () => {
    const prev = process.env.PLANSYNC_OUTBOX_CONSUMER;
    try {
      delete process.env.PLANSYNC_OUTBOX_CONSUMER;
      expect(isOutboxConsumerEnabled()).toBe(false);
      process.env.PLANSYNC_OUTBOX_CONSUMER = 'false';
      expect(isOutboxConsumerEnabled()).toBe(false);
      process.env.PLANSYNC_OUTBOX_CONSUMER = '1';
      expect(isOutboxConsumerEnabled()).toBe(false);
      process.env.PLANSYNC_OUTBOX_CONSUMER = 'true';
      expect(isOutboxConsumerEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PLANSYNC_OUTBOX_CONSUMER;
      else process.env.PLANSYNC_OUTBOX_CONSUMER = prev;
    }
  });
});

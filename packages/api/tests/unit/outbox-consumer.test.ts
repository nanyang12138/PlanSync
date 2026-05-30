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
  };
}

describe('R-162: processPendingOutboxEvents', () => {
  it('returns the empty result when no rows are pending', async () => {
    mocks.domainEventFindMany.mockResolvedValue([]);
    const res = await processPendingOutboxEvents();
    expect(res).toEqual({ processed: 0, delivered: 0, failed: 0, skipped: 0 });
    expect(mocks.domainEventUpdate).not.toHaveBeenCalled();
  });

  it('skips rows with no registered handler (leaves them undelivered)', async () => {
    mocks.domainEventFindMany.mockResolvedValue([row(1n, 'plan_activated')]);
    const res = await processPendingOutboxEvents();
    expect(res).toEqual({ processed: 0, delivered: 0, failed: 0, skipped: 1 });
    // Nothing claimed, nothing updated — the row stays for a later boot.
    expect(mocks.domainEventUpdateMany).not.toHaveBeenCalled();
    expect(mocks.domainEventUpdate).not.toHaveBeenCalled();
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
    const res = await processPendingOutboxEvents({ now });
    expect(res).toEqual({ processed: 1, delivered: 1, failed: 0, skipped: 0 });
    expect(seen).toEqual([7n]);
    expect(mocks.domainEventUpdateMany).toHaveBeenCalledWith({
      where: { id: 7n, deliveredAt: null },
      data: { attempt: { increment: 1 } },
    });
    expect(mocks.domainEventUpdate).toHaveBeenCalledWith({
      where: { id: 7n },
      data: { deliveredAt: now },
    });
  });

  it('respects the conditional claim: skips when another replica won the race', async () => {
    registerOutboxHandler('plan_activated', () => {});
    mocks.domainEventFindMany.mockResolvedValue([row(9n, 'plan_activated')]);
    // count: 0 ⇒ another worker already claimed this row.
    mocks.domainEventUpdateMany.mockResolvedValue({ count: 0 });

    const res = await processPendingOutboxEvents();
    expect(res.processed).toBe(0);
    expect(mocks.domainEventUpdate).not.toHaveBeenCalled();
  });

  it('counts a handler throw as failed and leaves the row undelivered', async () => {
    registerOutboxHandler('plan_activated', () => {
      throw new Error('handler boom');
    });
    mocks.domainEventFindMany.mockResolvedValue([row(11n, 'plan_activated')]);
    mocks.domainEventUpdateMany.mockResolvedValue({ count: 1 });

    const res = await processPendingOutboxEvents();
    expect(res).toEqual({ processed: 1, delivered: 0, failed: 1, skipped: 0 });
    // `attempt` was bumped via the claim, but deliveredAt was NOT set —
    // the next tick will retry.
    expect(mocks.domainEventUpdate).not.toHaveBeenCalled();
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

/**
 * R-209: outbox lease / ownership SQL semantics, against a real Postgres.
 *
 * R-208 proved the `attempt`-CAS claim is exclusive for two workers racing the
 * SAME read. It does NOT cover the *sequential* re-claim: a second worker
 * re-reading the row on a later tick while the first worker's handler is still
 * in flight (the row is still pending — deliveredAt/failedAt null). Under >1
 * worker that is a double dispatch.
 *
 * The lease closes that gap. These tests prove the SQL actually has the
 * behaviour the design depends on:
 *   - a row with a live lease (lockedUntil in the future) is invisible to the
 *     scan, so a second worker never even sees it;
 *   - the lease still serializes a claim that reads the post-increment attempt
 *     (so it's the lease, not only the attempt-CAS, doing the work);
 *   - an expired lease re-enters the scan (crash recovery);
 *   - a terminal write guarded by claimToken matches 0 rows once another worker
 *     has taken the row over (no stale double-settle).
 *
 * Like the R-208 suite, these operate on rows this test inserts under a unique
 * project id, so they are immune to the consumer's global scan — no
 * sibling-test interference.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { testPrisma } from '../helpers/request';

const PROJECT = `r209-${Math.random().toString(36).slice(2)}`;
const LEASE_MS = 60_000;

async function insertPending(attempt = 0): Promise<bigint> {
  const row = await testPrisma.domainEvent.create({
    data: {
      eventType: 'plan_activated',
      projectId: PROJECT,
      payload: { type: 'plan_activated', projectId: PROJECT, data: {} },
      attempt,
    },
  });
  return row.id;
}

/** The consumer's claim: attempt-CAS + lease acquire (free/expired lease only). */
const leaseClaim = (id: bigint, attempt: number, now: Date, token: string) =>
  testPrisma.domainEvent.updateMany({
    where: {
      id,
      deliveredAt: null,
      failedAt: null,
      attempt,
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: {
      attempt: { increment: 1 },
      lockedUntil: new Date(now.getTime() + LEASE_MS),
      claimToken: token,
    },
  });

/** The consumer's scan predicate, scoped to this test's project. */
const scan = (now: Date) =>
  testPrisma.domainEvent.findMany({
    where: {
      projectId: PROJECT,
      deliveredAt: null,
      failedAt: null,
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
  });

afterEach(async () => {
  await testPrisma.domainEvent.deleteMany({ where: { projectId: PROJECT } });
});

describe('R-209: lease visibility', () => {
  it('a row with a live lease is invisible to the scan', async () => {
    const now = new Date('2026-06-11T12:00:00Z');
    const id = await insertPending(0);

    // Worker A claims it: lease now extends to now + 60s.
    const claimed = await leaseClaim(id, 0, now, 'tA');
    expect(claimed.count).toBe(1);

    // Worker B scans at the same instant — the in-flight row must not appear.
    const visible = await scan(now);
    expect(visible.find((r) => r.id === id)).toBeUndefined();
  });

  it('the lease blocks a claim even when the attempt is re-read post-increment', async () => {
    const now = new Date('2026-06-11T12:00:00Z');
    const id = await insertPending(0);

    // A claims → attempt becomes 1, lease live.
    await leaseClaim(id, 0, now, 'tA');

    // B re-reads the row, sees attempt 1 (so attempt-CAS alone would let it
    // through), but the lease is still live → claim must match 0 rows.
    const stolen = await leaseClaim(id, 1, now, 'tB');
    expect(stolen.count).toBe(0);
  });

  it('an expired lease re-enters the scan and is re-claimable', async () => {
    const claimedAt = new Date('2026-06-11T12:00:00Z');
    const id = await insertPending(0);
    await leaseClaim(id, 0, claimedAt, 'tA'); // lease → 12:01:00Z

    // A later tick, after the lease has expired.
    const later = new Date('2026-06-11T12:02:00Z');
    const visible = await scan(later);
    expect(visible.find((r) => r.id === id)).toBeDefined();

    // And a new worker can re-claim it (attempt is now 1).
    const reclaim = await leaseClaim(id, 1, later, 'tB');
    expect(reclaim.count).toBe(1);
  });
});

describe('R-209: ownership (claimToken) on terminal writes', () => {
  it('a stale owner cannot settle a row that was taken over', async () => {
    const claimedAt = new Date('2026-06-11T12:00:00Z');
    const id = await insertPending(0);
    await leaseClaim(id, 0, claimedAt, 'tA'); // A owns it (token tA)

    // Lease expires; worker B takes over with a fresh token.
    const later = new Date('2026-06-11T12:02:00Z');
    const taken = await leaseClaim(id, 1, later, 'tB');
    expect(taken.count).toBe(1);

    // A's slow handler finally returns and tries to mark delivered with ITS
    // token — must match 0 rows (B is the owner now).
    const staleSettle = await testPrisma.domainEvent.updateMany({
      where: { id, claimToken: 'tA', deliveredAt: null, failedAt: null },
      data: { deliveredAt: later, lastError: null, lockedUntil: null, claimToken: null },
    });
    expect(staleSettle.count).toBe(0);

    // B settles with its own token — succeeds exactly once.
    const ownSettle = await testPrisma.domainEvent.updateMany({
      where: { id, claimToken: 'tB', deliveredAt: null, failedAt: null },
      data: { deliveredAt: later, lastError: null, lockedUntil: null, claimToken: null },
    });
    expect(ownSettle.count).toBe(1);

    const row = await testPrisma.domainEvent.findUnique({ where: { id } });
    expect(row?.deliveredAt).not.toBeNull();
    expect(row?.claimToken).toBeNull();
  });
});

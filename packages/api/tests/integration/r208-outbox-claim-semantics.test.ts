/**
 * R-208: outbox claim + terminal-state SQL semantics, against a real Postgres.
 *
 * The unit tests (outbox-consumer.test.ts) prove the consumer *issues* the
 * right queries (CAS claim where {id, deliveredAt:null, failedAt:null,
 * attempt}, guarded terminal updateMany). These tests prove that SQL actually
 * has the exclusivity / guard semantics the dead-letter design depends on —
 * the correctness blocker raised in review:
 *
 *   - two workers must NOT both claim the same row (else dead-letter races
 *     produce a row with both failedAt AND deliveredAt set);
 *   - a terminal row (delivered or dead-lettered) must never be flipped to the
 *     other terminal state.
 *
 * These operate directly on rows this test inserts (unique ids), so they are
 * immune to the consumer's global scan — no sibling-test interference.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { testPrisma } from '../helpers/request';

const PROJECT = `r208-${Math.random().toString(36).slice(2)}`;

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

const claim = (id: bigint, attempt: number) =>
  testPrisma.domainEvent.updateMany({
    where: { id, deliveredAt: null, failedAt: null, attempt },
    data: { attempt: { increment: 1 } },
  });

afterEach(async () => {
  await testPrisma.domainEvent.deleteMany({ where: { projectId: PROJECT } });
});

describe('R-208: exclusive CAS claim', () => {
  it('two claims reading the same attempt: exactly one wins', async () => {
    const id = await insertPending(0);

    // Both racers read attempt 0 and try to claim with `attempt: 0`. The first
    // increment makes attempt 1, so the second no longer matches.
    const first = await claim(id, 0);
    const second = await claim(id, 0);

    expect(first.count).toBe(1);
    expect(second.count).toBe(0);

    const row = await testPrisma.domainEvent.findUnique({ where: { id } });
    expect(row?.attempt).toBe(1); // bumped exactly once, not twice
  });

  it('concurrent claims (Promise.all) still yield exactly one winner', async () => {
    const id = await insertPending(0);

    const [a, b] = await Promise.all([claim(id, 0), claim(id, 0)]);

    expect([a.count, b.count].sort()).toEqual([0, 1]);
    const row = await testPrisma.domainEvent.findUnique({ where: { id } });
    expect(row?.attempt).toBe(1);
  });

  it('a dead-lettered row cannot be claimed (failedAt guard)', async () => {
    const id = await insertPending(2);
    await testPrisma.domainEvent.update({
      where: { id },
      data: { failedAt: new Date(), lastError: 'boom' },
    });

    // A stale worker that read attempt 2 before the dead-letter tries to claim.
    const res = await claim(id, 2);
    expect(res.count).toBe(0);
  });
});

describe('R-208: terminal-state guards (no contradictory rows)', () => {
  it('a dead-lettered row cannot be flipped to delivered', async () => {
    const id = await insertPending(3);
    await testPrisma.domainEvent.updateMany({
      where: { id, deliveredAt: null, failedAt: null },
      data: { failedAt: new Date(), lastError: 'gave up' },
    });

    // The success path is a guarded updateMany — it must NOT overwrite a
    // dead-lettered row.
    const res = await testPrisma.domainEvent.updateMany({
      where: { id, deliveredAt: null, failedAt: null },
      data: { deliveredAt: new Date(), lastError: null },
    });
    expect(res.count).toBe(0);

    const row = await testPrisma.domainEvent.findUnique({ where: { id } });
    expect(row?.deliveredAt).toBeNull();
    expect(row?.failedAt).not.toBeNull();
    expect(row?.lastError).toBe('gave up');
  });

  it('a delivered row cannot be flipped to dead-lettered', async () => {
    const id = await insertPending(0);
    await testPrisma.domainEvent.updateMany({
      where: { id, deliveredAt: null, failedAt: null },
      data: { deliveredAt: new Date(), lastError: null },
    });

    const res = await testPrisma.domainEvent.updateMany({
      where: { id, deliveredAt: null, failedAt: null },
      data: { failedAt: new Date(), lastError: 'late failure' },
    });
    expect(res.count).toBe(0);

    const row = await testPrisma.domainEvent.findUnique({ where: { id } });
    expect(row?.failedAt).toBeNull();
    expect(row?.deliveredAt).not.toBeNull();
  });
});

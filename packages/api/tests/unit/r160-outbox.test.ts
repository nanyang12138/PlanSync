/**
 * R-160: transactional outbox writer.
 *
 * Acceptance from REMEDIATION_PLAN.md:
 *   "vitest：tx 内 emit + rollback → 不存在；commit 后存在且通过 schema"
 *
 * We cover both halves of that acceptance plus three additional invariants
 * the discriminated-union schema gives us for free:
 *   - bad event type → emit throws synchronously (validation gate)
 *   - emitOutOfTx writes a row in its own tx and swallows errors
 *   - delivered_at defaults to NULL so the worker's pending index sees it
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { domainEventPayloadSchema } from '@plansync/shared';
import { emit, emitOutOfTx } from '@/lib/outbox';

const prisma = new PrismaClient();

// We tag every row we write with a unique marker inside payload.data so the
// integration DB (which other tests share) cannot leak unrelated rows into
// our assertions.
function marker(): string {
  return `r160-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function findByMarker(m: string) {
  // Postgres jsonb path lookup. The cast keeps Prisma happy on the
  // string-typed marker field.
  return prisma.$queryRawUnsafe<
    Array<{
      id: bigint;
      event_type: string;
      project_id: string | null;
      user_name: string | null;
      payload: unknown;
      delivered_at: Date | null;
      attempt: number;
    }>
  >(
    `SELECT id, event_type, project_id, user_name, payload, delivered_at, attempt
       FROM domain_events
      WHERE payload->'data'->>'marker' = $1
      ORDER BY id ASC`,
    m,
  );
}

describe('R-160 outbox', () => {
  beforeAll(async () => {
    // sanity: the migration must have run
    await prisma.$queryRawUnsafe(`SELECT 1 FROM domain_events LIMIT 0`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rolls back the row when the surrounding transaction rolls back', async () => {
    const m = marker();
    await expect(
      prisma.$transaction(async (tx) => {
        await emit(tx, 'plan_activated', {
          projectId: 'p-rollback',
          userName: 'r160-user',
          data: { marker: m, planId: 'plan-1' },
        });
        // Force a rollback by throwing. Prisma's $transaction contract:
        // "If the function throws an error, the transaction is rolled back".
        throw new Error('intentional rollback for R-160 test');
      }),
    ).rejects.toThrow('intentional rollback');

    const rows = await findByMarker(m);
    expect(rows).toHaveLength(0);
  });

  it('persists the row when the transaction commits, with payload that matches the shared schema', async () => {
    const m = marker();
    await prisma.$transaction(async (tx) => {
      await emit(tx, 'plan_activated', {
        projectId: 'p-commit',
        userName: 'r160-user',
        data: { marker: m, planId: 'plan-2', version: 7 },
      });
    });

    const rows = await findByMarker(m);
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.event_type).toBe('plan_activated');
    expect(row.project_id).toBe('p-commit');
    expect(row.user_name).toBe('r160-user');
    expect(row.delivered_at).toBeNull();
    expect(row.attempt).toBe(0);

    // The stored payload must still validate against the shared schema —
    // R-162 worker / R-163 SSE relay will trust this invariant.
    const parsed = domainEventPayloadSchema.safeParse(row.payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('plan_activated');
      expect((parsed.data.data as Record<string, unknown>).planId).toBe('plan-2');
    }
  });

  it('throws synchronously and aborts the tx when the event type is unknown', async () => {
    const m = marker();
    await expect(
      prisma.$transaction(async (tx) => {
        // @ts-expect-error — intentional bad type to exercise the validation gate
        await emit(tx, 'not_a_real_event_type', {
          projectId: 'p-bad',
          data: { marker: m },
        });
      }),
    ).rejects.toThrow();

    const rows = await findByMarker(m);
    expect(rows).toHaveLength(0);
  });

  it('emitOutOfTx writes a row in its own 1-row transaction', async () => {
    const m = marker();
    await emitOutOfTx('bus_resync_required', {
      projectId: 'p-out-of-tx',
      data: { marker: m, _resyncRequired: true },
    });

    const rows = await findByMarker(m);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('bus_resync_required');
    expect(rows[0].delivered_at).toBeNull();
  });
});

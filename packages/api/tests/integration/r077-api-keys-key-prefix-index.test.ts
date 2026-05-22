// R-077: api_keys table should have an index on key_prefix so that the
// per-prefix lookup performed by verifyApiKey() stops falling back to a
// sequential scan as the table grows.
import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type PgIndex = { indexname: string; indexdef: string };

describe('R-077: api_keys key_prefix index', () => {
  it('declares an index on (key_prefix)', async () => {
    const rows = await prisma.$queryRawUnsafe<PgIndex[]>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'api_keys'`,
    );
    const match = rows.find(
      (r) =>
        // Index on a single column key_prefix (the column may be quoted with mixed case "keyPrefix").
        /\(\s*"?key_?prefix"?\s*\)/i.test(r.indexdef) &&
        !/\bWHERE\b/i.test(r.indexdef),
    );
    expect(
      match,
      `expected an index on api_keys(key_prefix); got ${JSON.stringify(rows)}`,
    ).toBeTruthy();
  });

  it('the planner picks an index scan for (key_prefix) when seq scan is disabled', async () => {
    const project = await prisma.project.create({
      data: {
        name: `r077-explain-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        phase: 'planning',
        createdBy: 'r077-owner',
      },
    });
    const createdKeyIds: string[] = [];
    try {
      // Seed enough rows so the planner can sensibly compare seq vs index scan.
      const keyRows = Array.from({ length: 50 }).map((_, i) => ({
        projectId: project.id,
        name: `r077-key-${i}`,
        keyHash: `salt-${i}:hash-${i}`,
        keyPrefix: `ps_key_${i.toString().padStart(7, '0')}`,
        permissions: ['read'],
        createdBy: 'r077-owner',
      }));
      const created = await prisma.$transaction(
        keyRows.map((data) => prisma.apiKey.create({ data, select: { id: true } })),
      );
      created.forEach((row) => createdKeyIds.push(row.id));

      const planText = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
        const plan = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
          `EXPLAIN SELECT id FROM api_keys WHERE "keyPrefix" = $1`,
          'ps_key_0000001',
        );
        return plan.map((r) => r['QUERY PLAN']).join('\n');
      });

      expect(planText).toMatch(/Index Scan|Bitmap Index Scan|Index Only Scan/i);
      expect(planText).not.toMatch(/Seq Scan on api_keys/i);
    } finally {
      if (createdKeyIds.length > 0) {
        await prisma.apiKey.deleteMany({ where: { id: { in: createdKeyIds } } });
      }
      await prisma.project.delete({ where: { id: project.id } });
    }
  });
});

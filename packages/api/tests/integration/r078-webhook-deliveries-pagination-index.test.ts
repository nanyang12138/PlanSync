// R-078: webhook_deliveries should have a composite index that backs the
// "list this webhook's deliveries newest-first" pagination query so the
// planner can avoid a full sequential scan + sort as the table grows.
import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type PgIndex = { indexname: string; indexdef: string };

describe('R-078: webhook_deliveries pagination index', () => {
  it('declares an index on (webhookId, createdAt DESC)', async () => {
    const rows = await prisma.$queryRawUnsafe<PgIndex[]>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'webhook_deliveries'`,
    );
    const match = rows.find(
      (r) =>
        // Composite index whose first column is webhookId and whose second
        // column is createdAt DESC. Column names are quoted with mixed case
        // by Prisma migrations ("webhookId", "createdAt").
        /\(\s*"?webhook_?id"?\s*,\s*"?created_?at"?\s+DESC\s*\)/i.test(
          r.indexdef,
        ) && !/\bWHERE\b/i.test(r.indexdef),
    );
    expect(
      match,
      `expected an index on webhook_deliveries(webhookId, createdAt DESC); got ${JSON.stringify(rows)}`,
    ).toBeTruthy();
  });

  it('the planner picks an index scan for (webhookId, createdAt DESC) when seq scan is disabled', async () => {
    const project = await prisma.project.create({
      data: {
        name: `r078-explain-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        phase: 'planning',
        createdBy: 'r078-owner',
      },
    });
    const webhook = await prisma.webhook.create({
      data: {
        projectId: project.id,
        url: 'https://example.invalid/r078',
        events: ['plan_activated'],
        createdBy: 'r078-owner',
      },
    });
    try {
      // Seed enough rows that the planner can sensibly compare seq vs index scan.
      const deliveryRows = Array.from({ length: 50 }).map((_, i) => ({
        webhookId: webhook.id,
        event: 'plan_activated',
        requestBody: { i } as object,
        responseCode: 200,
        success: true,
        attempt: 1,
      }));
      await prisma.$transaction(
        deliveryRows.map((data) =>
          prisma.webhookDelivery.create({ data, select: { id: true } }),
        ),
      );

      const planText = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
        const plan = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
          `EXPLAIN SELECT id FROM webhook_deliveries WHERE "webhookId" = $1 ORDER BY "createdAt" DESC LIMIT 20`,
          webhook.id,
        );
        return plan.map((r) => r['QUERY PLAN']).join('\n');
      });

      expect(planText).toMatch(/Index Scan|Bitmap Index Scan|Index Only Scan/i);
      expect(planText).not.toMatch(/Seq Scan on webhook_deliveries/i);
    } finally {
      await prisma.webhookDelivery.deleteMany({
        where: { webhookId: webhook.id },
      });
      await prisma.webhook.delete({ where: { id: webhook.id } });
      await prisma.project.delete({ where: { id: project.id } });
    }
  });
});

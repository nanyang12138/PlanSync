// R-085: every column on the late-comer tables (api_keys, webhooks,
// webhook_deliveries, plan_diffs) should be stored with a snake_case
// identifier, matching the convention used by every other table in the
// schema. This test queries information_schema directly so it cannot be
// fooled by Prisma's `@map` masking — it asserts the actual on-disk
// PostgreSQL column names are snake_case after the rename migration.

import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type ColumnRow = { table_name: string; column_name: string };

const TABLES = [
  'api_keys',
  'webhooks',
  'webhook_deliveries',
  'plan_diffs',
] as const;

// Columns we expect to see (post-rename) on each table. We intentionally
// keep this list explicit instead of computing it so a regression that
// drops a column or adds a new camelCase column is surfaced immediately.
const EXPECTED_COLUMNS: Record<(typeof TABLES)[number], string[]> = {
  api_keys: [
    'id',
    'project_id',
    'name',
    'key_hash',
    'key_prefix',
    'permissions',
    'created_by',
    'last_used_at',
    'created_at',
    'exec_run_id',
    'expires_at',
  ],
  webhooks: [
    'id',
    'project_id',
    'url',
    'events',
    'secret',
    'active',
    'created_by',
    'created_at',
  ],
  webhook_deliveries: [
    'id',
    'webhook_id',
    'event',
    'request_body',
    'response_code',
    'success',
    'error_message',
    'attempt',
    'created_at',
  ],
  plan_diffs: [
    'id',
    'project_id',
    'from_plan_id',
    'to_plan_id',
    'changes',
    'generated_at',
  ],
};

describe('R-085: snake_case column names on late-comer tables', () => {
  it('has no camelCase column names left on the renamed tables', async () => {
    const rows = await prisma.$queryRawUnsafe<ColumnRow[]>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      TABLES,
    );

    const offenders = rows.filter((r) => /[A-Z]/.test(r.column_name));
    expect(
      offenders,
      `expected every column on ${TABLES.join(
        ', ',
      )} to be snake_case; found camelCase: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it.each(TABLES)('table %s has the expected snake_case columns', async (table) => {
    const rows = await prisma.$queryRawUnsafe<ColumnRow[]>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      table,
    );
    const actual = rows.map((r) => r.column_name).sort();
    const expected = [...EXPECTED_COLUMNS[table]].sort();
    expect(actual).toEqual(expected);
  });

  it('Prisma client can still create + read rows after the rename', async () => {
    const project = await prisma.project.create({
      data: {
        name: `r085-prisma-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        phase: 'planning',
        createdBy: 'r085-owner',
      },
    });
    try {
      const apiKey = await prisma.apiKey.create({
        data: {
          projectId: project.id,
          name: 'r085-key',
          keyHash: 'salt:hash',
          keyPrefix: 'ps_r085_001',
          permissions: ['read'],
          createdBy: 'r085-owner',
        },
      });
      const fetched = await prisma.apiKey.findUnique({
        where: { id: apiKey.id },
        select: {
          projectId: true,
          keyHash: true,
          keyPrefix: true,
          createdBy: true,
          createdAt: true,
        },
      });
      expect(fetched).toMatchObject({
        projectId: project.id,
        keyHash: 'salt:hash',
        keyPrefix: 'ps_r085_001',
        createdBy: 'r085-owner',
      });
      expect(fetched?.createdAt).toBeInstanceOf(Date);

      const webhook = await prisma.webhook.create({
        data: {
          projectId: project.id,
          url: 'https://example.invalid/r085',
          events: ['plan_activated'],
          createdBy: 'r085-owner',
        },
      });
      const delivery = await prisma.webhookDelivery.create({
        data: {
          webhookId: webhook.id,
          event: 'plan_activated',
          requestBody: { ok: true } as object,
          responseCode: 200,
          success: true,
          attempt: 1,
        },
      });
      const fetchedDelivery = await prisma.webhookDelivery.findUnique({
        where: { id: delivery.id },
        select: {
          webhookId: true,
          requestBody: true,
          responseCode: true,
          errorMessage: true,
          createdAt: true,
        },
      });
      expect(fetchedDelivery).toMatchObject({
        webhookId: webhook.id,
        responseCode: 200,
        errorMessage: null,
      });
      expect(fetchedDelivery?.createdAt).toBeInstanceOf(Date);

      await prisma.webhookDelivery.delete({ where: { id: delivery.id } });
      await prisma.webhook.delete({ where: { id: webhook.id } });
      await prisma.apiKey.delete({ where: { id: apiKey.id } });
    } finally {
      await prisma.project.delete({ where: { id: project.id } });
    }
  });
});

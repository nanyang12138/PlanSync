// R-084: schema.prisma cannot declare partial unique indexes, so the
// invariants behind them live in raw-SQL migrations and are documented in
// `packages/api/prisma/migrations/README.md`. This test guards against the
// common foot-gun of someone running `prisma db push` (or otherwise
// regenerating the schema from `schema.prisma`) and silently dropping the
// indexes — without them, two CRITICAL race conditions reopen (R-048 multiple
// active plans per project, R-049 multiple running runs per task).
import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type PgIndex = { indexname: string; indexdef: string };

async function listIndexes(table: string): Promise<PgIndex[]> {
  return prisma.$queryRawUnsafe<PgIndex[]>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
    table,
  );
}

describe('R-084: documented partial unique indexes exist after migrate deploy', () => {
  it('plans has plans_one_active_per_project WHERE status = active', async () => {
    const rows = await listIndexes('plans');
    const match = rows.find((r) => r.indexname === 'plans_one_active_per_project');
    expect(
      match,
      `expected partial unique index plans_one_active_per_project on plans; got ${JSON.stringify(
        rows.map((r) => r.indexname),
      )}`,
    ).toBeTruthy();
    expect(match!.indexdef).toMatch(/CREATE\s+UNIQUE\s+INDEX/i);
    expect(match!.indexdef).toMatch(/\(\s*project_id\s*\)/i);
    expect(match!.indexdef).toMatch(/WHERE\s+\(?\s*status\s*=\s*'active'/i);
  });

  it('execution_runs has execution_runs_one_running_per_task WHERE status = running', async () => {
    const rows = await listIndexes('execution_runs');
    const match = rows.find((r) => r.indexname === 'execution_runs_one_running_per_task');
    expect(
      match,
      `expected partial unique index execution_runs_one_running_per_task on execution_runs; got ${JSON.stringify(
        rows.map((r) => r.indexname),
      )}`,
    ).toBeTruthy();
    expect(match!.indexdef).toMatch(/CREATE\s+UNIQUE\s+INDEX/i);
    expect(match!.indexdef).toMatch(/\(\s*task_id\s*\)/i);
    expect(match!.indexdef).toMatch(/WHERE\s+\(?\s*status\s*=\s*'running'/i);
  });
});

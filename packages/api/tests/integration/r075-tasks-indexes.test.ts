// R-075: tasks table should have composite indexes
// (project_id, status) and (project_id, assignee) so that hot list queries
// stop falling back to a sequential scan.
import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type PgIndex = { indexname: string; indexdef: string };

describe('R-075: tasks composite indexes', () => {
  it('declares an index on (project_id, status)', async () => {
    const rows = await prisma.$queryRawUnsafe<PgIndex[]>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'tasks'`,
    );
    const match = rows.find(
      (r) =>
        /\(\s*project_id\s*,\s*status\s*\)/i.test(r.indexdef) &&
        !/\bWHERE\b/i.test(r.indexdef),
    );
    expect(match, `expected an index on tasks(project_id, status); got ${JSON.stringify(rows)}`).toBeTruthy();
  });

  it('declares an index on (project_id, assignee)', async () => {
    const rows = await prisma.$queryRawUnsafe<PgIndex[]>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'tasks'`,
    );
    const match = rows.find(
      (r) =>
        /\(\s*project_id\s*,\s*assignee\s*\)/i.test(r.indexdef) &&
        !/\bWHERE\b/i.test(r.indexdef),
    );
    expect(match, `expected an index on tasks(project_id, assignee); got ${JSON.stringify(rows)}`).toBeTruthy();
  });

  it('the planner picks an index scan for (project_id, status) when seq scan is disabled', async () => {
    // Seed a project with mixed-status tasks so EXPLAIN has something to plan.
    const project = await prisma.project.create({
      data: {
        name: `r075-explain-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        phase: 'planning',
        createdBy: 'r075-owner',
      },
    });
    try {
      const rows = Array.from({ length: 50 }).map((_, i) => ({
        projectId: project.id,
        title: `t-${i}`,
        type: 'code',
        status: i % 2 === 0 ? 'todo' : 'done',
        boundPlanVersion: 1,
        assignee: i % 3 === 0 ? 'alice' : null,
      }));
      await prisma.task.createMany({ data: rows });

      // Run EXPLAIN inside an interactive transaction so SET LOCAL sticks.
      const planText = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
        const plan = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
          `EXPLAIN SELECT id FROM tasks WHERE project_id = $1 AND status = 'todo'`,
          project.id,
        );
        return plan.map((r) => r['QUERY PLAN']).join('\n');
      });

      // With seqscan disabled, the planner must use an index path. Bitmap or
      // plain Index Scan are both acceptable.
      expect(planText).toMatch(/Index Scan|Bitmap Index Scan/i);
      expect(planText).not.toMatch(/Seq Scan on tasks/i);
    } finally {
      await prisma.project.delete({ where: { id: project.id } });
    }
  });
});

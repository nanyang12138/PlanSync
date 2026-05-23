// R-076: drift_alerts table should have composite indexes
// (project_id, status) and (task_id, status) so that the per-project drift
// list and per-task drift lookups stop falling back to a sequential scan.
import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type PgIndex = { indexname: string; indexdef: string };

describe('R-076: drift_alerts composite indexes', () => {
  it('declares an index on (project_id, status)', async () => {
    const rows = await prisma.$queryRawUnsafe<PgIndex[]>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'drift_alerts'`,
    );
    const match = rows.find(
      (r) =>
        /\(\s*project_id\s*,\s*status\s*\)/i.test(r.indexdef) && !/\bWHERE\b/i.test(r.indexdef),
    );
    expect(
      match,
      `expected an index on drift_alerts(project_id, status); got ${JSON.stringify(rows)}`,
    ).toBeTruthy();
  });

  it('declares an index on (task_id, status)', async () => {
    const rows = await prisma.$queryRawUnsafe<PgIndex[]>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'drift_alerts'`,
    );
    const match = rows.find(
      (r) => /\(\s*task_id\s*,\s*status\s*\)/i.test(r.indexdef) && !/\bWHERE\b/i.test(r.indexdef),
    );
    expect(
      match,
      `expected an index on drift_alerts(task_id, status); got ${JSON.stringify(rows)}`,
    ).toBeTruthy();
  });

  it('the planner picks an index scan for (project_id, status) when seq scan is disabled', async () => {
    // Seed a project + plan + tasks + drift alerts so EXPLAIN has rows to plan.
    const project = await prisma.project.create({
      data: {
        name: `r076-explain-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        phase: 'planning',
        createdBy: 'r076-owner',
      },
    });
    try {
      // R-083: tasks now have a composite FK to plans(project_id, version),
      // so seed a v1 plan before creating any tasks. Without this the
      // task.create calls below fail with `tasks_project_id_bound_plan_version_fkey`.
      await prisma.plan.create({
        data: {
          projectId: project.id,
          title: 'r076 v1',
          goal: 'g',
          scope: 's',
          version: 1,
          status: 'active',
          createdBy: 'r076-owner',
          activatedAt: new Date(),
          activatedBy: 'r076-owner',
        },
      });
      const tasks = await Promise.all(
        Array.from({ length: 10 }).map((_, i) =>
          prisma.task.create({
            data: {
              projectId: project.id,
              title: `t-${i}`,
              type: 'code',
              status: 'todo',
              boundPlanVersion: 1,
            },
          }),
        ),
      );
      // R-051: the partial unique index `drift_alerts_one_open_per_task`
      // allows at most one open alert per task. Generate one open + four
      // resolved per task so this fixture remains representative of real
      // drift history (still 50 rows total) without tripping the index.
      const driftRows = tasks.flatMap((t, i) =>
        Array.from({ length: 5 }).map((_, j) => ({
          projectId: project.id,
          taskId: t.id,
          severity: 'medium',
          reason: `drift-${i}-${j}`,
          status: j === 0 ? 'open' : 'resolved',
          resolvedAction: j === 0 ? null : 'no_impact',
          resolvedAt: j === 0 ? null : new Date(),
          currentPlanVersion: 2,
          taskBoundVersion: 1,
        })),
      );
      await prisma.driftAlert.createMany({ data: driftRows });

      const planText = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
        const plan = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
          `EXPLAIN SELECT id FROM drift_alerts WHERE project_id = $1 AND status = 'open'`,
          project.id,
        );
        return plan.map((r) => r['QUERY PLAN']).join('\n');
      });

      // With seqscan disabled, the planner must use an index path. Bitmap or
      // plain Index Scan are both acceptable.
      expect(planText).toMatch(/Index Scan|Bitmap Index Scan/i);
      expect(planText).not.toMatch(/Seq Scan on drift_alerts/i);
    } finally {
      await prisma.project.delete({ where: { id: project.id } });
    }
  });
});

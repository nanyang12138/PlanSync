// R-081: drift_alerts.plan_diff_id should be a real foreign key into
// plan_diffs(id) with ON DELETE SET NULL semantics. Prior to this fix the
// column was an untyped string reference, so deleting a PlanDiff could
// leave dangling pointers on DriftAlert rows.
import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type PgConstraint = {
  conname: string;
  pg_get_constraintdef: string;
};

describe('R-081: drift_alerts.plan_diff_id foreign key', () => {
  it('declares an FK on (plan_diff_id) referencing plan_diffs(id) with ON DELETE SET NULL', async () => {
    const rows = await prisma.$queryRawUnsafe<PgConstraint[]>(
      `SELECT c.conname, pg_get_constraintdef(c.oid)
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = 'drift_alerts'
          AND c.contype = 'f'`,
    );
    const match = rows.find((r) =>
      /FOREIGN KEY\s*\(\s*plan_diff_id\s*\)\s*REFERENCES\s+plan_diffs\s*\(\s*id\s*\)[\s\S]*ON DELETE SET NULL/i.test(
        r.pg_get_constraintdef,
      ),
    );
    expect(
      match,
      `expected FK drift_alerts(plan_diff_id) -> plan_diffs(id) ON DELETE SET NULL; got ${JSON.stringify(
        rows,
      )}`,
    ).toBeTruthy();
  });

  it('deleting a PlanDiff nulls drift_alerts.plan_diff_id instead of cascading', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const project = await prisma.project.create({
      data: {
        name: `r081-${suffix}`,
        phase: 'planning',
        createdBy: 'r081-owner',
      },
    });
    try {
      // PlanDiff currently has no FK to plans (tracked by R-082), so we
      // can use synthetic ids here without seeding real Plan rows.
      const planDiff = await prisma.planDiff.create({
        data: {
          projectId: project.id,
          fromPlanId: `from-${suffix}`,
          toPlanId: `to-${suffix}`,
          changes: { added: [], removed: [] },
        },
      });
      const task = await prisma.task.create({
        data: {
          projectId: project.id,
          title: 'r081-task',
          type: 'code',
          status: 'todo',
          boundPlanVersion: 1,
        },
      });
      const alert = await prisma.driftAlert.create({
        data: {
          projectId: project.id,
          taskId: task.id,
          severity: 'medium',
          reason: 'r081-test',
          currentPlanVersion: 2,
          taskBoundVersion: 1,
          planDiffId: planDiff.id,
        },
      });

      // Sanity check: relation is wired up.
      expect(alert.planDiffId).toBe(planDiff.id);

      // Deleting the PlanDiff should null the alert's planDiffId, not
      // delete the alert.
      await prisma.planDiff.delete({ where: { id: planDiff.id } });

      const after = await prisma.driftAlert.findUnique({
        where: { id: alert.id },
      });
      expect(after).not.toBeNull();
      expect(after?.planDiffId).toBeNull();
    } finally {
      await prisma.project.delete({ where: { id: project.id } });
    }
  });

  it('rejects inserting a drift_alert with a planDiffId that does not exist', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const project = await prisma.project.create({
      data: {
        name: `r081-bad-${suffix}`,
        phase: 'planning',
        createdBy: 'r081-owner',
      },
    });
    try {
      const task = await prisma.task.create({
        data: {
          projectId: project.id,
          title: 'r081-bad-task',
          type: 'code',
          status: 'todo',
          boundPlanVersion: 1,
        },
      });
      await expect(
        prisma.driftAlert.create({
          data: {
            projectId: project.id,
            taskId: task.id,
            severity: 'medium',
            reason: 'r081-bad',
            currentPlanVersion: 2,
            taskBoundVersion: 1,
            planDiffId: 'does-not-exist-xyz',
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.project.delete({ where: { id: project.id } });
    }
  });
});

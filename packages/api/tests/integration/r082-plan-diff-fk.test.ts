// R-082: PlanDiff.fromPlanId / toPlanId must have foreign-key constraints to
// plans(id). Until this remediation those columns were plain TEXT with no
// referential integrity, so a cached diff could end up pointing at a vanished
// plan. The new FKs (Cascade on delete/update) guarantee:
//   - deleting a referenced plan cascades the diff row away
//   - inserting a diff row that references a non-existent plan id is rejected
//     by Postgres with a FK violation (Prisma surfaces this as P2003)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestProject, cleanupProject, testPrisma } from '../helpers/request';

describe('R-082: PlanDiff has FK to plans(id) on fromPlanId / toPlanId', () => {
  const owner = 'r082-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  async function createDraftPlan(version: number, title: string) {
    return testPrisma.plan.create({
      data: {
        projectId,
        title,
        goal: 'g',
        scope: 's',
        version,
        status: 'draft',
        createdBy: owner,
      },
    });
  }

  it('rejects PlanDiff insert when fromPlanId does not match any plans.id', async () => {
    const real = await createDraftPlan(1, 'R082 real toPlan');
    try {
      await expect(
        testPrisma.planDiff.create({
          data: {
            projectId,
            fromPlanId: 'plan_does_not_exist_for_r082_from',
            toPlanId: real.id,
            changes: { synthetic: true } as object,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    } finally {
      // Ensure nothing leaked by the failed insert above.
      const stragglers = await testPrisma.planDiff.findMany({ where: { toPlanId: real.id } });
      expect(stragglers).toHaveLength(0);
      await testPrisma.plan.delete({ where: { id: real.id } });
    }
  });

  it('rejects PlanDiff insert when toPlanId does not match any plans.id', async () => {
    const real = await createDraftPlan(2, 'R082 real fromPlan');
    try {
      await expect(
        testPrisma.planDiff.create({
          data: {
            projectId,
            fromPlanId: real.id,
            toPlanId: 'plan_does_not_exist_for_r082_to',
            changes: { synthetic: true } as object,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    } finally {
      await testPrisma.plan.delete({ where: { id: real.id } });
    }
  });

  it('cascade-deletes diff rows when a referenced plan is deleted', async () => {
    const fromPlan = await createDraftPlan(3, 'R082 cascade from');
    const toPlan = await createDraftPlan(4, 'R082 cascade to');

    const diff = await testPrisma.planDiff.create({
      data: {
        projectId,
        fromPlanId: fromPlan.id,
        toPlanId: toPlan.id,
        changes: { summary: 'r082-cascade' } as object,
      },
    });

    // Sanity: the diff exists right now.
    expect(await testPrisma.planDiff.findUnique({ where: { id: diff.id } })).not.toBeNull();

    // Deleting either endpoint should cascade the diff away.
    await testPrisma.plan.delete({ where: { id: fromPlan.id } });
    expect(await testPrisma.planDiff.findUnique({ where: { id: diff.id } })).toBeNull();

    // The other endpoint must still exist (only the diff cascades, not the
    // unrelated `toPlan`). Cleanup explicitly so the project teardown does
    // not have to.
    expect(await testPrisma.plan.findUnique({ where: { id: toPlan.id } })).not.toBeNull();
    await testPrisma.plan.delete({ where: { id: toPlan.id } });
  });

  it('cascade-deletes diff rows when the toPlan endpoint is deleted', async () => {
    const fromPlan = await createDraftPlan(5, 'R082 to-cascade from');
    const toPlan = await createDraftPlan(6, 'R082 to-cascade to');

    const diff = await testPrisma.planDiff.create({
      data: {
        projectId,
        fromPlanId: fromPlan.id,
        toPlanId: toPlan.id,
        changes: { summary: 'r082-to-cascade' } as object,
      },
    });

    await testPrisma.plan.delete({ where: { id: toPlan.id } });
    expect(await testPrisma.planDiff.findUnique({ where: { id: diff.id } })).toBeNull();
    await testPrisma.plan.delete({ where: { id: fromPlan.id } });
  });
});

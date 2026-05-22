// R-086: PlanComment.parent self-relation must use ON DELETE RESTRICT so a
// hard delete of a parent comment that still has replies fails loudly with
// a Postgres foreign-key violation (Prisma surfaces as P2003) instead of
// silently orphaning the thread via the previous implicit `SET NULL`.
//
// The application path is soft delete (`isDeleted = true`), but a stray
// admin script or future migration must not be allowed to break the thread
// structure quietly. Plan deletion still cascades the entire comment
// subtree because `plan_comments.plan_id -> plans.id` is `ON DELETE
// CASCADE`; Postgres handles parent + children in a single statement so
// the RESTRICT check on `parent_id` is satisfied.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestProject, cleanupProject, testPrisma } from '../helpers/request';

describe('R-086: PlanComment self-relation onDelete is RESTRICT', () => {
  const owner = 'r086-owner';
  let projectId: string;
  let planId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const plan = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'R086 plan',
        goal: 'g',
        scope: 's',
        version: 1,
        status: 'draft',
        createdBy: owner,
      },
    });
    planId = plan.id;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  async function createComment(opts: { parentId?: string }) {
    return testPrisma.planComment.create({
      data: {
        planId,
        authorName: owner,
        authorType: 'human',
        content: 'r086 body',
        parentId: opts.parentId,
      },
    });
  }

  it('rejects hard-delete of a parent comment when replies still exist', async () => {
    const parent = await createComment({});
    const child = await createComment({ parentId: parent.id });

    try {
      await expect(
        testPrisma.planComment.delete({ where: { id: parent.id } }),
      ).rejects.toMatchObject({ code: 'P2003' });

      // Both rows must still be present after the rejected delete — RESTRICT
      // prevents the change, it does not silently null the parentId out
      // (that was the old SET NULL behaviour we are explicitly moving away
      // from).
      const stillParent = await testPrisma.planComment.findUnique({
        where: { id: parent.id },
      });
      expect(stillParent).not.toBeNull();
      const stillChild = await testPrisma.planComment.findUnique({
        where: { id: child.id },
      });
      expect(stillChild?.parentId).toBe(parent.id);
    } finally {
      // Tear down child first so the parent can be removed in cleanup.
      await testPrisma.planComment.delete({ where: { id: child.id } });
      await testPrisma.planComment.delete({ where: { id: parent.id } });
    }
  });

  it('allows hard-delete of a parent comment once its replies are gone', async () => {
    const parent = await createComment({});
    const child = await createComment({ parentId: parent.id });

    await testPrisma.planComment.delete({ where: { id: child.id } });

    // No more referrers → RESTRICT no longer applies, delete must succeed.
    await testPrisma.planComment.delete({ where: { id: parent.id } });

    expect(await testPrisma.planComment.findUnique({ where: { id: parent.id } })).toBeNull();
  });

  it('still cascade-deletes the whole comment thread when the plan is deleted', async () => {
    // Use a dedicated draft plan so we can hard-delete it without disturbing
    // the project's other state.
    const throwawayPlan = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'R086 throwaway',
        goal: 'g',
        scope: 's',
        version: 2,
        status: 'draft',
        createdBy: owner,
      },
    });
    const parent = await testPrisma.planComment.create({
      data: {
        planId: throwawayPlan.id,
        authorName: owner,
        authorType: 'human',
        content: 'thread root',
      },
    });
    const child = await testPrisma.planComment.create({
      data: {
        planId: throwawayPlan.id,
        authorName: owner,
        authorType: 'human',
        content: 'thread reply',
        parentId: parent.id,
      },
    });

    await testPrisma.plan.delete({ where: { id: throwawayPlan.id } });

    // The plan -> comments cascade must take the entire thread down, even
    // though parent_id has ON DELETE RESTRICT, because both rows are
    // deleted within the same cascading statement.
    expect(await testPrisma.planComment.findUnique({ where: { id: parent.id } })).toBeNull();
    expect(await testPrisma.planComment.findUnique({ where: { id: child.id } })).toBeNull();
  });
});

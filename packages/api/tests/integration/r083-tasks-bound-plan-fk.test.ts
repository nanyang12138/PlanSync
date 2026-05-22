// R-083: Task.boundPlanVersion must be a real foreign key into
// plans(project_id, version). Until this remediation the column was a plain
// integer with no referential integrity, so a bug in the activate / rebind
// flow could leave a task pointing at a plan version that never existed,
// silently breaking drift severity classification (which keys off the bound
// version) and the task-pack snapshot read.
//
// The new FK (Cascade on delete/update) guarantees:
//   - inserting a task with a (project_id, bound_plan_version) tuple that
//     does not match any row in `plans` is rejected by Postgres with a FK
//     violation (Prisma surfaces this as P2003)
//   - deleting a referenced plan cascades the bound tasks away, which keeps
//     the project-level cascade chain consistent regardless of the order
//     Postgres evaluates the two cascades from `projects`
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { createTestProject, cleanupProject, testPrisma } from '../helpers/request';

type PgConstraint = {
  conname: string;
  pg_get_constraintdef: string;
};

describe('R-083: Task has composite FK to plans(project_id, version)', () => {
  const owner = 'r083-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    // Seed a v1 plan so the "happy path" task insert below succeeds.
    await testPrisma.plan.create({
      data: {
        projectId,
        title: 'r083 v1',
        goal: 'g',
        scope: 's',
        version: 1,
        status: 'active',
        createdBy: owner,
        activatedAt: new Date(),
        activatedBy: owner,
      },
    });
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('declares an FK on (project_id, bound_plan_version) referencing plans(project_id, version)', async () => {
    const rows = await testPrisma.$queryRawUnsafe<PgConstraint[]>(
      `SELECT c.conname, pg_get_constraintdef(c.oid)
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = 'tasks'
          AND c.contype = 'f'`,
    );
    const match = rows.find((r) =>
      /FOREIGN KEY\s*\(\s*project_id\s*,\s*bound_plan_version\s*\)\s*REFERENCES\s+plans\s*\(\s*project_id\s*,\s*version\s*\)/i.test(
        r.pg_get_constraintdef,
      ),
    );
    expect(
      match,
      `expected FK tasks(project_id, bound_plan_version) -> plans(project_id, version); got ${JSON.stringify(
        rows,
      )}`,
    ).toBeTruthy();
    // The cascade behaviour matters for the project-deletion order argument
    // documented in the migration; assert it explicitly so a future schema
    // change cannot silently downgrade it to NO ACTION.
    expect(match!.pg_get_constraintdef).toMatch(/ON UPDATE CASCADE/i);
    expect(match!.pg_get_constraintdef).toMatch(/ON DELETE CASCADE/i);
  });

  it('declares a backing index on (project_id, bound_plan_version) so cascades stay on a B-tree path', async () => {
    const rows = await testPrisma.$queryRawUnsafe<{
      indexname: string;
      indexdef: string;
    }[]>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'tasks'`,
    );
    const match = rows.find(
      (r) =>
        /\(\s*project_id\s*,\s*bound_plan_version\s*\)/i.test(r.indexdef) &&
        !/\bWHERE\b/i.test(r.indexdef),
    );
    expect(
      match,
      `expected index on tasks(project_id, bound_plan_version); got ${JSON.stringify(
        rows.map((r) => r.indexname),
      )}`,
    ).toBeTruthy();
  });

  it('accepts a task insert when the bound plan version exists', async () => {
    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'r083 happy task',
        type: 'code',
        status: 'todo',
        boundPlanVersion: 1,
      },
    });
    expect(task.boundPlanVersion).toBe(1);
    await testPrisma.task.delete({ where: { id: task.id } });
  });

  it('rejects a task insert when no plan with that version exists in the project', async () => {
    await expect(
      testPrisma.task.create({
        data: {
          projectId,
          title: 'r083 ghost-version task',
          type: 'code',
          status: 'todo',
          // version 99 was never created on this project; the FK must reject.
          boundPlanVersion: 99,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('rejects a task insert when the plan exists but in a different project', async () => {
    // Build a second project with a v42 plan, then try to bind a task in the
    // first project to v42. The first project has a v1 plan but no v42, so
    // the only matching `plans` row globally lives in the second project. The
    // composite FK is keyed on the tuple (project_id, version), so the
    // first-project task insert must be rejected — cross-project version
    // leakage must not satisfy referential integrity.
    const { projectId: otherProjectId } = await createTestProject(`${owner}-other`);
    try {
      await testPrisma.plan.create({
        data: {
          projectId: otherProjectId,
          title: 'r083 other v42',
          goal: 'g',
          scope: 's',
          version: 42,
          status: 'active',
          createdBy: owner,
          activatedAt: new Date(),
          activatedBy: owner,
        },
      });
      // Use raw SQL to bypass Prisma's relational-input plumbing — the plain
      // `prisma.task.create({ data: { projectId, boundPlanVersion } })` shape
      // would also work, but raw SQL exercises the database constraint
      // directly, which is what we actually care about.
      await expect(
        testPrisma.$executeRawUnsafe(
          `INSERT INTO "tasks" ("id", "project_id", "title", "type", "status", "bound_plan_version", "created_at", "updated_at")
             VALUES ('r083-cross-task', $1, 'r083 cross task', 'code', 'todo', 42, NOW(), NOW())`,
          projectId,
        ),
      ).rejects.toThrow();
    } finally {
      await cleanupProject(otherProjectId);
    }
    // Sanity check: the failed insert above should have left no row behind.
    const stragglers = await testPrisma.task.findMany({
      where: { projectId, title: 'r083 cross task' },
    });
    expect(stragglers).toHaveLength(0);
  });

  it('cascade-deletes bound tasks when their plan is hard-deleted', async () => {
    // Use a fresh project so the cascade behaviour is observable in
    // isolation — deleting plan v1 on the shared project would also blow
    // away the task seeded by the happy-path test above.
    const { projectId: cascadeProjectId } = await createTestProject(`${owner}-cascade`);
    try {
      const plan = await testPrisma.plan.create({
        data: {
          projectId: cascadeProjectId,
          title: 'r083 cascade plan',
          goal: 'g',
          scope: 's',
          version: 1,
          status: 'draft',
          createdBy: owner,
        },
      });
      const task = await testPrisma.task.create({
        data: {
          projectId: cascadeProjectId,
          title: 'r083 cascade task',
          type: 'code',
          status: 'todo',
          boundPlanVersion: 1,
        },
      });

      // Sanity check: the task exists right now.
      expect(
        await testPrisma.task.findUnique({ where: { id: task.id } }),
      ).not.toBeNull();

      await testPrisma.plan.delete({ where: { id: plan.id } });

      // The plan-side cascade should have removed the bound task as well.
      expect(
        await testPrisma.task.findUnique({ where: { id: task.id } }),
      ).toBeNull();
    } finally {
      await cleanupProject(cascadeProjectId);
    }
  });
});

// Belt-and-suspenders: keep a reference to Prisma so an unused-import lint
// rule cannot drop the namespace import (the P2003 matcher above relies on it
// being part of the runtime types Prisma exports).
void Prisma;

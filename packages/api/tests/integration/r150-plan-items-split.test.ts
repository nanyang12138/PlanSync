// R-150 (B13): Plan-as-code split tables.
//
// This is the *foundation* migration — it adds three new sibling tables
// (`plan_deliverables`, `plan_constraints`, `plan_standards`) that mirror the
// legacy `String[]` columns on `plans` but carry stable IDs, slugs, status
// and (for deliverables) a self-superseded-by link. R-150 is intentionally
// *additive*: no existing read paths change, the legacy columns stay intact,
// and later remediation items (R-151..R-154) wire writes / reads / drift
// through the new tables.
//
// The contract this test pins is therefore narrow but load-bearing:
//
//   1. The three tables exist with the column set documented in the
//      remediation plan (R-150 fix_steps).
//   2. (plan_id, slug) is unique on each table.
//   3. plan_deliverables carries a (plan_id, status) index so the
//      "active deliverables for plan X" query stays on a B-tree path.
//   4. Each table has an FK to plans(id) ON DELETE CASCADE so deleting a
//      plan does not leave dangling rows.
//   5. plan_deliverables.superseded_by_id is a self-FK with ON DELETE
//      SET NULL — deleting a replacement deliverable must preserve the
//      original row's history rather than cascade-delete it.
//   6. The legacy `plans.deliverables` / `plans.constraints` /
//      `plans.standards` text[] columns are *still* present, so existing
//      `plan_show` / `plan_pack` consumers continue to receive the same
//      shape until R-152 dual-writes through the new tables.
//
// Functional smoke at the Prisma layer:
//   - Create plan_deliverable with status='draft' → readable.
//   - Create another deliverable that supersedes the first → both rows
//     observable; deleting the second nulls supersedes_by_id on the first.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { createTestProject, cleanupProject, testPrisma } from '../helpers/request';

type PgColumn = { column_name: string; is_nullable: 'YES' | 'NO'; data_type: string };
type PgIndex = { indexname: string; indexdef: string };
type PgConstraint = { conname: string; pg_get_constraintdef: string };

async function tableColumns(table: string): Promise<PgColumn[]> {
  return testPrisma.$queryRawUnsafe<PgColumn[]>(
    `SELECT column_name, is_nullable, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    table,
  );
}

async function tableIndexes(table: string): Promise<PgIndex[]> {
  return testPrisma.$queryRawUnsafe<PgIndex[]>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
    table,
  );
}

async function tableForeignKeys(table: string): Promise<PgConstraint[]> {
  return testPrisma.$queryRawUnsafe<PgConstraint[]>(
    `SELECT c.conname, pg_get_constraintdef(c.oid)
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND t.relname = $1 AND c.contype = 'f'`,
    table,
  );
}

describe('R-150: plan_items split — additive Deliverable/Constraint/Standard tables', () => {
  const owner = 'r150-owner';
  let projectId: string;
  let planId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const plan = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'r150 v1',
        goal: 'g',
        scope: 's',
        version: 1,
        status: 'active',
        createdBy: owner,
        activatedAt: new Date(),
        activatedBy: owner,
      },
    });
    planId = plan.id;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  describe('schema shape', () => {
    it('plan_deliverables has the documented columns', async () => {
      const cols = await tableColumns('plan_deliverables');
      const byName = new Map(cols.map((c) => [c.column_name, c]));

      // Required columns from R-150 fix_steps step 1.
      for (const required of ['id', 'plan_id', 'slug', 'title', 'body', 'status', 'created_at']) {
        expect(byName.get(required), `expected NOT NULL column ${required}`).toMatchObject({
          is_nullable: 'NO',
        });
      }
      // Optional columns: ref_type / ref_uri / superseded_by_id.
      for (const optional of ['ref_type', 'ref_uri', 'superseded_by_id']) {
        expect(byName.get(optional), `expected nullable column ${optional}`).toMatchObject({
          is_nullable: 'YES',
        });
      }
    });

    it('plan_constraints / plan_standards carry the documented columns (no status)', async () => {
      for (const table of ['plan_constraints', 'plan_standards']) {
        const cols = await tableColumns(table);
        const names = new Set(cols.map((c) => c.column_name));
        for (const required of ['id', 'plan_id', 'slug', 'body', 'kind', 'created_at']) {
          expect(names.has(required), `${table} should have ${required}`).toBe(true);
        }
        // Constraint / Standard tables intentionally do NOT have a `status`
        // column — they are value-typed and supersede via plan version
        // replacement, not a per-row lifecycle.
        expect(names.has('status'), `${table} must not have a status column`).toBe(false);
      }
    });

    it('declares (plan_id, slug) unique and (plan_id, status) index on plan_deliverables', async () => {
      const idx = await tableIndexes('plan_deliverables');
      const planSlugUnique = idx.find(
        (i) =>
          /UNIQUE\b/i.test(i.indexdef) &&
          /\(\s*plan_id\s*,\s*slug\s*\)/i.test(i.indexdef),
      );
      expect(
        planSlugUnique,
        `expected UNIQUE INDEX on plan_deliverables(plan_id, slug); got ${JSON.stringify(idx)}`,
      ).toBeTruthy();
      const planStatusIdx = idx.find(
        (i) =>
          !/UNIQUE\b/i.test(i.indexdef) &&
          /\(\s*plan_id\s*,\s*status\s*\)/i.test(i.indexdef),
      );
      expect(
        planStatusIdx,
        `expected non-unique INDEX on plan_deliverables(plan_id, status)`,
      ).toBeTruthy();
    });

    it('declares (plan_id, slug) unique on plan_constraints and plan_standards', async () => {
      for (const table of ['plan_constraints', 'plan_standards']) {
        const idx = await tableIndexes(table);
        const match = idx.find(
          (i) =>
            /UNIQUE\b/i.test(i.indexdef) &&
            /\(\s*plan_id\s*,\s*slug\s*\)/i.test(i.indexdef),
        );
        expect(match, `expected UNIQUE INDEX on ${table}(plan_id, slug)`).toBeTruthy();
      }
    });

    it('declares plan_id FK ON DELETE CASCADE on all three tables', async () => {
      for (const table of ['plan_deliverables', 'plan_constraints', 'plan_standards']) {
        const fks = await tableForeignKeys(table);
        const planFk = fks.find((f) =>
          /FOREIGN KEY\s*\(\s*plan_id\s*\)\s*REFERENCES\s+plans\s*\(\s*id\s*\)/i.test(
            f.pg_get_constraintdef,
          ),
        );
        expect(
          planFk,
          `expected ${table}.plan_id FK -> plans(id); got ${JSON.stringify(fks)}`,
        ).toBeTruthy();
        expect(planFk!.pg_get_constraintdef).toMatch(/ON DELETE CASCADE/i);
      }
    });

    it('declares superseded_by_id self-FK ON DELETE SET NULL on plan_deliverables', async () => {
      const fks = await tableForeignKeys('plan_deliverables');
      const selfFk = fks.find((f) =>
        /FOREIGN KEY\s*\(\s*superseded_by_id\s*\)\s*REFERENCES\s+plan_deliverables\s*\(\s*id\s*\)/i.test(
          f.pg_get_constraintdef,
        ),
      );
      expect(selfFk, `expected superseded_by_id self-FK; got ${JSON.stringify(fks)}`).toBeTruthy();
      // SET NULL — deleting the replacement must preserve the predecessor's
      // history row (just clear the back-link), not cascade-delete it.
      expect(selfFk!.pg_get_constraintdef).toMatch(/ON DELETE SET NULL/i);
    });

    it('keeps the legacy plans.deliverables / constraints / standards text[] columns', async () => {
      // Pinning this is the heart of "smoke plan_show 仍返回旧 String[] 形状"
      // from the R-150 verification: as long as these columns are present and
      // typed text[], existing read paths continue to project them and the
      // public API surface does not change.
      const planCols = await tableColumns('plans');
      const byName = new Map(planCols.map((c) => [c.column_name, c]));
      for (const legacy of ['deliverables', 'constraints', 'standards']) {
        const col = byName.get(legacy);
        expect(col, `plans.${legacy} must still exist as text[]`).toBeDefined();
        // Postgres reports text[] as data_type 'ARRAY'; check that explicitly
        // so a future migration that "tidies" the column to plain text is
        // caught here.
        expect(col!.data_type).toBe('ARRAY');
      }
    });
  });

  describe('functional smoke', () => {
    it('inserts, queries and supersedes a deliverable end-to-end', async () => {
      const original = await testPrisma.planDeliverable.create({
        data: {
          planId,
          slug: 'auth/oidc-callback',
          title: 'OIDC callback handler',
          body: 'Implement /auth/callback handler that exchanges the code.',
          refType: 'file_glob',
          refUri: 'packages/api/src/app/auth/callback/**',
          status: 'active',
        },
      });
      expect(original.status).toBe('active');
      expect(original.refType).toBe('file_glob');

      // (plan_id, slug) uniqueness must reject a second insert with the same slug.
      await expect(
        testPrisma.planDeliverable.create({
          data: {
            planId,
            slug: 'auth/oidc-callback',
            title: 'duplicate',
            body: 'should not be allowed',
            status: 'draft',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      // Insert a successor and link the original to it.
      const replacement = await testPrisma.planDeliverable.create({
        data: {
          planId,
          slug: 'auth/oidc-callback-v2',
          title: 'OIDC callback handler v2',
          body: 'Refactored callback that also rotates session keys.',
          status: 'draft',
        },
      });
      const linked = await testPrisma.planDeliverable.update({
        where: { id: original.id },
        data: { status: 'deprecated', supersededById: replacement.id },
      });
      expect(linked.status).toBe('deprecated');
      expect(linked.supersededById).toBe(replacement.id);

      // Deleting the replacement must NOT cascade-delete the predecessor —
      // the SET NULL behaviour preserves history.
      await testPrisma.planDeliverable.delete({ where: { id: replacement.id } });
      const survivor = await testPrisma.planDeliverable.findUnique({
        where: { id: original.id },
      });
      expect(survivor, 'predecessor must survive replacement deletion').not.toBeNull();
      expect(survivor!.supersededById).toBeNull();

      // Cleanup so other tests in this file can reuse the plan.
      await testPrisma.planDeliverable.delete({ where: { id: original.id } });
    });

    it('cascade-deletes plan_deliverables / constraints / standards when the plan is hard-deleted', async () => {
      const { projectId: cascadeProjectId } = await createTestProject(`${owner}-cascade`);
      try {
        const plan = await testPrisma.plan.create({
          data: {
            projectId: cascadeProjectId,
            title: 'r150 cascade plan',
            goal: 'g',
            scope: 's',
            version: 1,
            status: 'draft',
            createdBy: owner,
          },
        });
        const deliv = await testPrisma.planDeliverable.create({
          data: {
            planId: plan.id,
            slug: 'foo',
            title: 'foo',
            body: 'foo',
            status: 'draft',
          },
        });
        const constraint = await testPrisma.planConstraint.create({
          data: { planId: plan.id, slug: 'no-prod-secrets', body: 'never log secrets' },
        });
        const standard = await testPrisma.planStandard.create({
          data: { planId: plan.id, slug: 'eslint', body: 'eslint must pass' },
        });

        // Sanity check: rows visible right now.
        expect(await testPrisma.planDeliverable.findUnique({ where: { id: deliv.id } })).not.toBeNull();
        expect(await testPrisma.planConstraint.findUnique({ where: { id: constraint.id } })).not.toBeNull();
        expect(await testPrisma.planStandard.findUnique({ where: { id: standard.id } })).not.toBeNull();

        await testPrisma.plan.delete({ where: { id: plan.id } });

        // ON DELETE CASCADE on the plan FK must wipe all three child rows.
        expect(await testPrisma.planDeliverable.findUnique({ where: { id: deliv.id } })).toBeNull();
        expect(await testPrisma.planConstraint.findUnique({ where: { id: constraint.id } })).toBeNull();
        expect(await testPrisma.planStandard.findUnique({ where: { id: standard.id } })).toBeNull();
      } finally {
        await cleanupProject(cascadeProjectId);
      }
    });
  });
});

// Belt-and-suspenders: keep a reference to Prisma so an unused-import lint
// rule cannot drop the namespace import (the P2002 matcher above relies on
// it being part of the runtime types Prisma exports).
void Prisma;

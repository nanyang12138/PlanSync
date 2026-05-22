// R-150: split the legacy `plans.deliverables / .constraints / .standards`
// String[] columns into three sibling tables. This test pins down the three
// guarantees the work item promised:
//
//   1. Migration up is OK — the three tables exist with the expected
//      columns, the (plan_id, slug) UNIQUE indexes, and the
//      (plan_id, status) / (plan_id, kind) supporting indexes.
//   2. Prisma generate is OK — the new models are reachable on the Prisma
//      client and round-trip through `create` + `findUnique`, including
//      the (plan_id, slug) UNIQUE constraint and the self-FK
//      `superseded_by_id` chain on `plan_deliverables`.
//   3. Smoke `plan_show` (`GET /api/projects/:projectId/plans/:planId`)
//      still returns the legacy `deliverables / constraints / standards:
//      string[]` shape, so no existing consumer breaks just because the
//      tables now exist. The new tables are intentionally NOT joined into
//      the response yet — that switch belongs to R-151/R-152.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { GET as planGet } from '@/app/api/projects/[projectId]/plans/[planId]/route';
import {
  makeReq,
  createTestProject,
  cleanupProject,
} from '../helpers/request';

const prisma = new PrismaClient();

type PgIndex = { indexname: string; indexdef: string };
type PgColumn = { column_name: string; data_type: string; is_nullable: string };

async function indexesOf(table: string): Promise<PgIndex[]> {
  return prisma.$queryRawUnsafe<PgIndex[]>(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = $1`,
    table,
  );
}

async function columnsOf(table: string): Promise<PgColumn[]> {
  return prisma.$queryRawUnsafe<PgColumn[]>(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    table,
  );
}

describe('R-150: plan items split (deliverables / constraints / standards)', () => {
  describe('migration shape', () => {
    it('creates plan_deliverables with the documented columns', async () => {
      const cols = await columnsOf('plan_deliverables');
      const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
      // Required columns from the fix_steps spec.
      expect(byName.id).toBeTruthy();
      expect(byName.plan_id).toBeTruthy();
      expect(byName.slug).toBeTruthy();
      expect(byName.title).toBeTruthy();
      expect(byName.body).toBeTruthy();
      expect(byName.ref_type).toBeTruthy();
      expect(byName.ref_uri).toBeTruthy();
      expect(byName.status).toBeTruthy();
      expect(byName.superseded_by_id).toBeTruthy();
      expect(byName.created_at).toBeTruthy();
      // Required columns must be NOT NULL; ref_* / superseded_by_id are nullable.
      expect(byName.id.is_nullable).toBe('NO');
      expect(byName.plan_id.is_nullable).toBe('NO');
      expect(byName.slug.is_nullable).toBe('NO');
      expect(byName.title.is_nullable).toBe('NO');
      expect(byName.body.is_nullable).toBe('NO');
      expect(byName.status.is_nullable).toBe('NO');
      expect(byName.ref_type.is_nullable).toBe('YES');
      expect(byName.ref_uri.is_nullable).toBe('YES');
      expect(byName.superseded_by_id.is_nullable).toBe('YES');
    });

    it('creates plan_constraints / plan_standards with the documented columns', async () => {
      for (const table of ['plan_constraints', 'plan_standards']) {
        const cols = await columnsOf(table);
        const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
        expect(byName.id, `${table}.id`).toBeTruthy();
        expect(byName.plan_id, `${table}.plan_id`).toBeTruthy();
        expect(byName.slug, `${table}.slug`).toBeTruthy();
        expect(byName.body, `${table}.body`).toBeTruthy();
        expect(byName.kind, `${table}.kind`).toBeTruthy();
        expect(byName.created_at, `${table}.created_at`).toBeTruthy();
        // All five non-id columns are NOT NULL.
        expect(byName.plan_id.is_nullable).toBe('NO');
        expect(byName.slug.is_nullable).toBe('NO');
        expect(byName.body.is_nullable).toBe('NO');
        expect(byName.kind.is_nullable).toBe('NO');
      }
    });

    it('declares the (plan_id, slug) UNIQUE on all three tables', async () => {
      for (const table of ['plan_deliverables', 'plan_constraints', 'plan_standards']) {
        const rows = await indexesOf(table);
        const match = rows.find(
          (r) =>
            /UNIQUE/i.test(r.indexdef) &&
            /\(\s*"?plan_id"?\s*,\s*"?slug"?\s*\)/i.test(r.indexdef),
        );
        expect(
          match,
          `expected UNIQUE (plan_id, slug) on ${table}; got ${JSON.stringify(rows)}`,
        ).toBeTruthy();
      }
    });

    it('declares the (plan_id, status) supporting index on plan_deliverables', async () => {
      const rows = await indexesOf('plan_deliverables');
      const match = rows.find(
        (r) =>
          !/UNIQUE/i.test(r.indexdef) &&
          /\(\s*"?plan_id"?\s*,\s*"?status"?\s*\)/i.test(r.indexdef),
      );
      expect(
        match,
        `expected (plan_id, status) index on plan_deliverables; got ${JSON.stringify(rows)}`,
      ).toBeTruthy();
    });

    it('declares the (plan_id, kind) supporting index on plan_constraints / plan_standards', async () => {
      for (const table of ['plan_constraints', 'plan_standards']) {
        const rows = await indexesOf(table);
        const match = rows.find(
          (r) =>
            !/UNIQUE/i.test(r.indexdef) &&
            /\(\s*"?plan_id"?\s*,\s*"?kind"?\s*\)/i.test(r.indexdef),
        );
        expect(
          match,
          `expected (plan_id, kind) index on ${table}; got ${JSON.stringify(rows)}`,
        ).toBeTruthy();
      }
    });

    it('plan_deliverables.plan_id and superseded_by_id are real foreign keys', async () => {
      type Row = {
        constraint_name: string;
        column_name: string;
        foreign_table_name: string;
        foreign_column_name: string;
        delete_rule: string;
      };
      const rows = await prisma.$queryRawUnsafe<Row[]>(
        `SELECT
            tc.constraint_name,
            kcu.column_name,
            ccu.table_name AS foreign_table_name,
            ccu.column_name AS foreign_column_name,
            rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name
         JOIN information_schema.referential_constraints rc
           ON tc.constraint_name = rc.constraint_name
         WHERE tc.table_name = 'plan_deliverables'
           AND tc.constraint_type = 'FOREIGN KEY'`,
      );
      const byCol = Object.fromEntries(rows.map((r) => [r.column_name, r]));
      expect(byCol.plan_id?.foreign_table_name).toBe('plans');
      expect(byCol.plan_id?.foreign_column_name).toBe('id');
      expect(byCol.plan_id?.delete_rule).toBe('CASCADE');
      expect(byCol.superseded_by_id?.foreign_table_name).toBe('plan_deliverables');
      expect(byCol.superseded_by_id?.foreign_column_name).toBe('id');
      expect(byCol.superseded_by_id?.delete_rule).toBe('SET NULL');
    });
  });

  describe('prisma client surface', () => {
    let projectId: string;
    let planId: string;

    beforeAll(async () => {
      ({ projectId } = await createTestProject('r150-owner'));
      const plan = await prisma.plan.create({
        data: {
          projectId,
          title: 'r150 plan',
          goal: 'g',
          scope: 's',
          version: 1,
          status: 'active',
          createdBy: 'r150-owner',
          activatedAt: new Date(),
          activatedBy: 'r150-owner',
        },
      });
      planId = plan.id;
    });

    afterAll(async () => {
      await cleanupProject(projectId);
    });

    it('lets us round-trip a deliverable + supersession + slug uniqueness', async () => {
      const v1 = await prisma.planDeliverable.create({
        data: {
          planId,
          slug: 'auth/oidc-callback',
          title: 'OIDC callback handler v1',
          body: 'Wire /auth/callback to the OIDC provider.',
          refType: 'file_glob',
          refUri: 'packages/api/src/app/api/auth/**',
          status: 'active',
        },
      });

      const v2 = await prisma.planDeliverable.create({
        data: {
          planId,
          slug: 'auth/oidc-callback-v2',
          title: 'OIDC callback handler v2',
          body: 'Replace the legacy callback with PKCE flow.',
          status: 'active',
          supersededById: null,
        },
      });
      // Mark v1 as superseded by v2.
      const v1Updated = await prisma.planDeliverable.update({
        where: { id: v1.id },
        data: { status: 'deprecated', supersededById: v2.id },
      });
      expect(v1Updated.supersededById).toBe(v2.id);

      // (plan_id, slug) UNIQUE: re-using slug v1 within the same plan must fail.
      await expect(
        prisma.planDeliverable.create({
          data: {
            planId,
            slug: 'auth/oidc-callback', // same as v1
            title: 'duplicate',
            body: 'duplicate',
            status: 'draft',
          },
        }),
      ).rejects.toThrow();

      // Successor self-relation is reachable from the supersedes side.
      const successor = await prisma.planDeliverable.findUnique({
        where: { id: v2.id },
        include: { supersedes: true },
      });
      expect(successor?.supersedes.map((d) => d.id)).toContain(v1.id);
    });

    it('lets us round-trip a constraint and a standard on the same plan', async () => {
      const c = await prisma.planConstraint.create({
        data: {
          planId,
          slug: 'security/no-secrets-in-logs',
          body: 'API keys must never appear in log lines.',
          kind: 'security',
        },
      });
      const s = await prisma.planStandard.create({
        data: {
          planId,
          slug: 'naming/snake-case-columns',
          body: 'Postgres columns are snake_case via @map.',
          kind: 'naming',
        },
      });
      expect(c.id).toBeTruthy();
      expect(s.id).toBeTruthy();

      // Cross-table slug collisions are allowed (constraints and standards
      // live in separate namespaces).
      await prisma.planStandard.create({
        data: {
          planId,
          slug: 'security/no-secrets-in-logs',
          body: 'No secrets in logs (also a standard).',
          kind: 'security',
        },
      });
    });
  });

  describe('plan_show smoke (legacy String[] shape preserved)', () => {
    let projectId: string;
    let planId: string;

    beforeAll(async () => {
      ({ projectId } = await createTestProject('r150-show-owner'));
      const plan = await prisma.plan.create({
        data: {
          projectId,
          title: 'r150 show plan',
          goal: 'g',
          scope: 's',
          version: 1,
          status: 'active',
          createdBy: 'r150-show-owner',
          activatedAt: new Date(),
          activatedBy: 'r150-show-owner',
          // Seed legacy String[] columns. R-150 is purely additive, so these
          // must continue to surface verbatim on plan_show.
          deliverables: ['legacy-deliverable-a', 'legacy-deliverable-b'],
          constraints: ['legacy-constraint'],
          standards: ['legacy-standard'],
        },
      });
      planId = plan.id;

      // Also write rows into the new tables. Even with new rows present,
      // the API response must still expose the legacy String[] columns and
      // must NOT silently start returning rows from `plan_deliverables`.
      await prisma.planDeliverable.create({
        data: {
          planId,
          slug: 'new/shape-deliverable',
          title: 'New shape',
          body: 'Should not appear on plan_show response yet.',
          status: 'active',
        },
      });
    });

    afterAll(async () => {
      await cleanupProject(projectId);
    });

    it('returns deliverables / constraints / standards as string[] (legacy shape)', async () => {
      const res = await planGet(
        makeReq(`/api/projects/${projectId}/plans/${planId}`, {
          method: 'GET',
          userName: 'r150-show-owner',
        }),
        { params: { projectId, planId } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(Array.isArray(body.data.deliverables)).toBe(true);
      expect(Array.isArray(body.data.constraints)).toBe(true);
      expect(Array.isArray(body.data.standards)).toBe(true);
      // Items are still plain strings, not row objects.
      expect(body.data.deliverables).toEqual([
        'legacy-deliverable-a',
        'legacy-deliverable-b',
      ]);
      expect(body.data.constraints).toEqual(['legacy-constraint']);
      expect(body.data.standards).toEqual(['legacy-standard']);
      // The new tables are intentionally NOT joined into the response yet
      // (R-151/R-152 will switch the read path). Make that contract explicit
      // so a future PR doesn't quietly start exposing the new shape.
      expect(body.data.deliverableItems).toBeUndefined();
      expect(body.data.constraintItems).toBeUndefined();
      expect(body.data.standardItems).toBeUndefined();
    });
  });
});

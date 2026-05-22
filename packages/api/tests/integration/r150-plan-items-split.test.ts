// R-150: smoke tests for the normalized PlanDeliverable / PlanConstraint /
// PlanStandard side tables.
//
// Per the remediation plan the verification asks for three things:
//   1. The migration ran cleanly (Prisma generate succeeded and the tables
//      exist) — covered here by the pg_indexes/pg_constraint metadata
//      assertions plus a real round-trip insert.
//   2. CHECK constraints / unique indexes from the migration are present so
//      writers can't silently violate the documented state machine.
//   3. `plan_show` still returns the legacy `String[]` shape — covered by
//      reading a freshly-created plan via Prisma and asserting the
//      `deliverables / constraints / standards` array fields are untouched.
//
// Until R-151 backfills the new tables, they are intentionally empty for
// existing plans, so the test inserts its own rows to exercise the schema.

import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type PgIndex = { indexname: string; indexdef: string };
type PgCheck = { conname: string; check: string };

async function createPlan(label: string) {
  const project = await prisma.project.create({
    data: {
      name: `r150-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      phase: 'planning',
      createdBy: 'r150-owner',
    },
  });
  const plan = await prisma.plan.create({
    data: {
      projectId: project.id,
      version: 1,
      status: 'draft',
      title: 'r150 plan',
      goal: 'g',
      scope: 's',
      // R-150 verification: legacy String[] columns must remain untouched.
      // They keep being the canonical source of truth until R-151 / R-152.
      deliverables: ['legacy deliverable one', 'legacy deliverable two'],
      constraints: ['legacy constraint'],
      standards: ['legacy standard'],
      createdBy: 'r150-owner',
    },
  });
  return { project, plan };
}

describe('R-150: plan-items split tables', () => {
  it('creates plan_deliverables / plan_constraints / plan_standards tables with the documented indexes', async () => {
    const tables = ['plan_deliverables', 'plan_constraints', 'plan_standards'] as const;
    for (const table of tables) {
      const rows = await prisma.$queryRawUnsafe<PgIndex[]>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
        table,
      );
      const uniqueSlug = rows.find(
        (r) =>
          /UNIQUE/i.test(r.indexdef) &&
          /\(\s*plan_id\s*,\s*slug\s*\)/i.test(r.indexdef),
      );
      expect(
        uniqueSlug,
        `${table} should have UNIQUE(plan_id, slug); got ${JSON.stringify(rows)}`,
      ).toBeTruthy();
    }

    const deliverableIdx = await prisma.$queryRawUnsafe<PgIndex[]>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'plan_deliverables'`,
    );
    expect(
      deliverableIdx.find(
        (r) =>
          /\(\s*plan_id\s*,\s*status\s*\)/i.test(r.indexdef) &&
          !/UNIQUE/i.test(r.indexdef) &&
          !/\bWHERE\b/i.test(r.indexdef),
      ),
      'plan_deliverables should have index (plan_id, status)',
    ).toBeTruthy();
  });

  it('enforces the documented status / refType CHECK constraints on plan_deliverables', async () => {
    const rows = await prisma.$queryRawUnsafe<PgCheck[]>(
      `SELECT con.conname, pg_get_constraintdef(con.oid) AS check
         FROM pg_constraint con
         JOIN pg_class cls ON cls.oid = con.conrelid
        WHERE cls.relname = 'plan_deliverables' AND con.contype = 'c'`,
    );
    const status = rows.find((r) => /status/i.test(r.check));
    const refType = rows.find((r) => /ref_type/i.test(r.check));
    expect(status, `expected plan_deliverables.status CHECK; got ${JSON.stringify(rows)}`).toBeTruthy();
    expect(refType, `expected plan_deliverables.ref_type CHECK; got ${JSON.stringify(rows)}`).toBeTruthy();

    // The migration documents these enum sets; assert they survive.
    expect(status!.check).toMatch(/draft/);
    expect(status!.check).toMatch(/active/);
    expect(status!.check).toMatch(/done/);
    expect(status!.check).toMatch(/deprecated/);
    expect(refType!.check).toMatch(/file_glob/);
    expect(refType!.check).toMatch(/api_spec/);
    expect(refType!.check).toMatch(/figma_frame/);
    expect(refType!.check).toMatch(/notion_page/);
    expect(refType!.check).toMatch(/free/);
  });

  it('round-trips a deliverable with the unique (plan_id, slug) guarantee and self-supersession FK', async () => {
    const { project, plan } = await createPlan('roundtrip');
    try {
      const v1 = await prisma.planDeliverable.create({
        data: {
          planId: plan.id,
          slug: 'auth/oidc-callback',
          title: 'OIDC callback endpoint',
          body: 'Handle code exchange and session creation.',
          refType: 'api_spec',
          refUri: 'docs/openapi/auth.yaml#/paths/~1oidc~1callback',
          status: 'active',
        },
      });
      expect(v1.id).toBeTruthy();
      expect(v1.status).toBe('active');

      // (plan_id, slug) unique: a second row with the same slug must fail.
      await expect(
        prisma.planDeliverable.create({
          data: {
            planId: plan.id,
            slug: 'auth/oidc-callback',
            title: 'duplicate',
          },
        }),
      ).rejects.toThrow(/Unique constraint|P2002/i);

      // Self-supersession FK: a later row can reference the earlier id.
      const v2 = await prisma.planDeliverable.create({
        data: {
          planId: plan.id,
          slug: 'auth/oidc-callback-v2',
          title: 'OIDC callback endpoint (rev)',
          status: 'active',
        },
      });
      await prisma.planDeliverable.update({
        where: { id: v1.id },
        data: { status: 'deprecated', supersededById: v2.id },
      });
      const reloaded = await prisma.planDeliverable.findUnique({ where: { id: v1.id } });
      expect(reloaded?.supersededById).toBe(v2.id);
      expect(reloaded?.status).toBe('deprecated');

      // CHECK constraint should reject an invalid status string.
      await expect(
        prisma.planDeliverable.create({
          data: {
            planId: plan.id,
            slug: 'auth/bogus-status',
            title: 'bogus',
            status: 'not_a_real_status',
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.project.delete({ where: { id: project.id } });
    }
  });

  it('keeps the legacy Plan.deliverables / constraints / standards String[] columns intact (plan_show shape unchanged)', async () => {
    const { project, plan } = await createPlan('legacy-shape');
    try {
      // Seed a parallel deliverable row; it must not affect plan_show output.
      await prisma.planDeliverable.create({
        data: {
          planId: plan.id,
          slug: 'side-table-item',
          title: 'should not surface yet',
          status: 'active',
        },
      });
      await prisma.planConstraint.create({
        data: { planId: plan.id, slug: 'sec/no-secrets-in-logs', body: 'no secrets in logs', kind: 'security' },
      });
      await prisma.planStandard.create({
        data: { planId: plan.id, slug: 'fmt/eslint-strict', body: 'must pass eslint', kind: 'lint' },
      });

      const reloaded = await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } });
      // Until R-151/R-152 the legacy String[] columns remain canonical and
      // the side tables are a parallel-but-invisible view. plan_show today
      // reads from these columns, so they must continue to round-trip.
      expect(reloaded.deliverables).toEqual(['legacy deliverable one', 'legacy deliverable two']);
      expect(reloaded.constraints).toEqual(['legacy constraint']);
      expect(reloaded.standards).toEqual(['legacy standard']);
    } finally {
      await prisma.project.delete({ where: { id: project.id } });
    }
  });

  it('cascades plan_constraints / plan_standards / plan_deliverables on plan delete', async () => {
    const { project, plan } = await createPlan('cascade');
    try {
      await prisma.planConstraint.create({
        data: { planId: plan.id, slug: 'sec/x', body: 'x', kind: 'security' },
      });
      await prisma.planStandard.create({
        data: { planId: plan.id, slug: 'fmt/x', body: 'x', kind: 'lint' },
      });
      await prisma.planDeliverable.create({
        data: { planId: plan.id, slug: 'd/x', title: 'x', status: 'draft' },
      });

      // Deleting the parent project cascades to plans, and plans cascade to
      // all three side tables. After the delete, none of the rows we just
      // inserted should remain.
      await prisma.project.delete({ where: { id: project.id } });

      const [c, s, d] = await Promise.all([
        prisma.planConstraint.count({ where: { planId: plan.id } }),
        prisma.planStandard.count({ where: { planId: plan.id } }),
        prisma.planDeliverable.count({ where: { planId: plan.id } }),
      ]);
      expect(c).toBe(0);
      expect(s).toBe(0);
      expect(d).toBe(0);
    } catch (e) {
      // best-effort cleanup if assertions failed mid-test
      await prisma.project.delete({ where: { id: project.id } }).catch(() => undefined);
      throw e;
    }
  });
});

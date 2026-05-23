// R-150: structured plan item tables — `plan_deliverables`,
// `plan_constraints`, `plan_standards` — exist alongside the legacy
// `String[]` columns on `plans`. This test pins down the **schema-level**
// invariants that the rest of the rollout (R-151..R-157) will rely on:
//   1. The tables exist with the expected on-disk column shape.
//   2. (plan_id, slug) is unique on every table — the slug is the stable,
//      human-addressable identity used by drift v3 and the verification
//      rules work.
//   3. (plan_id, status) / (plan_id, kind) composite indexes back the hot
//      list views.
//   4. The CHECK constraints on `plan_deliverables.ref_type` and
//      `plan_deliverables.status` reject unknown values.
//   5. Plan cascade-deletes wipe the sibling rows; deleting a deliverable
//      that is pointed at by another deliverable's `superseded_by_id`
//      nulls out the back-pointer instead of cascading further.
//   6. **Plan.show shape is unchanged** — the legacy `String[]` columns
//      remain populated and untouched by the additive migration.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type IndexRow = { indexname: string; indexdef: string };
type ColumnRow = { column_name: string; data_type: string; is_nullable: string };
type ConstraintRow = { conname: string; pg_get_constraintdef: string };

let projectId: string;
let planId: string;

beforeAll(async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const project = await prisma.project.create({
    data: {
      name: `r150-${suffix}`,
      phase: 'planning',
      createdBy: 'r150-owner',
    },
  });
  projectId = project.id;

  const plan = await prisma.plan.create({
    data: {
      projectId,
      version: 1,
      title: 'r150 v1',
      goal: 'goal',
      scope: 'scope',
      // Seed the legacy String[] columns so invariant #6 has something to
      // assert against — the additive migration must not have rewritten or
      // dropped them.
      deliverables: ['ship the docs', 'ship the api'],
      constraints: ['no breaking changes'],
      standards: ['eslint clean'],
      status: 'active',
      createdBy: 'r150-owner',
      activatedAt: new Date(),
      activatedBy: 'r150-owner',
    },
  });
  planId = plan.id;
});

afterAll(async () => {
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
  await prisma.$disconnect();
});

describe('R-150: plan item split tables', () => {
  it('creates plan_deliverables / plan_constraints / plan_standards with the expected columns', async () => {
    const rows = await prisma.$queryRaw<ColumnRow[]>`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('plan_deliverables', 'plan_constraints', 'plan_standards')
      ORDER BY table_name, ordinal_position
    `;
    const byTable: Record<string, string[]> = {};
    for (const r of rows as Array<ColumnRow & { table_name: string }>) {
      (byTable[r.table_name] ||= []).push(r.column_name);
    }
    expect(byTable.plan_deliverables).toEqual([
      'id',
      'plan_id',
      'slug',
      'title',
      'body',
      'ref_type',
      'ref_uri',
      'status',
      'superseded_by_id',
      'created_at',
    ]);
    expect(byTable.plan_constraints).toEqual([
      'id',
      'plan_id',
      'slug',
      'body',
      'kind',
      'created_at',
    ]);
    expect(byTable.plan_standards).toEqual(['id', 'plan_id', 'slug', 'body', 'kind', 'created_at']);
  });

  it('declares (plan_id, slug) unique + (plan_id, status|kind) index on each sibling table', async () => {
    for (const table of ['plan_deliverables', 'plan_constraints', 'plan_standards'] as const) {
      const indexes = await prisma.$queryRawUnsafe<IndexRow[]>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
        table,
      );
      const uniqueSlug = indexes.find(
        (i) => /UNIQUE/i.test(i.indexdef) && /\(\s*plan_id\s*,\s*slug\s*\)/i.test(i.indexdef),
      );
      expect(
        uniqueSlug,
        `expected unique (plan_id, slug) index on ${table}; got ${JSON.stringify(indexes)}`,
      ).toBeTruthy();

      const secondaryCol = table === 'plan_deliverables' ? 'status' : 'kind';
      const composite = indexes.find(
        (i) =>
          !/UNIQUE/i.test(i.indexdef) &&
          new RegExp(`\\(\\s*plan_id\\s*,\\s*${secondaryCol}\\s*\\)`, 'i').test(i.indexdef),
      );
      expect(
        composite,
        `expected (plan_id, ${secondaryCol}) index on ${table}; got ${JSON.stringify(indexes)}`,
      ).toBeTruthy();
    }
  });

  it('enforces CHECK constraints on plan_deliverables.ref_type and .status', async () => {
    const checks = await prisma.$queryRaw<ConstraintRow[]>`
      SELECT conname, pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conrelid = 'plan_deliverables'::regclass
        AND contype = 'c'
    `;
    const defs = checks.map((c) => c.pg_get_constraintdef.toLowerCase());
    expect(defs.some((d) => d.includes('ref_type') && d.includes("'file_glob'"))).toBe(true);
    expect(defs.some((d) => d.includes('status') && d.includes("'active'"))).toBe(true);

    // Inserting a bogus ref_type must be rejected by Postgres.
    await expect(
      prisma.planDeliverable.create({
        data: {
          planId,
          slug: 'bogus-ref-type',
          title: 'x',
          body: 'x',
          refType: 'not-a-real-kind',
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.planDeliverable.create({
        data: {
          planId,
          slug: 'bogus-status',
          title: 'x',
          body: 'x',
          status: 'in_progress',
        },
      }),
    ).rejects.toThrow();
  });

  it('accepts every allowed ref_type / status value', async () => {
    const refTypes = ['file_glob', 'api_spec', 'figma_frame', 'notion_page', 'free'] as const;
    const statuses = ['draft', 'active', 'done', 'deprecated'] as const;
    for (let i = 0; i < refTypes.length; i++) {
      await prisma.planDeliverable.create({
        data: {
          planId,
          slug: `allowed-ref-${i}`,
          title: `allowed ${i}`,
          body: 'b',
          refType: refTypes[i],
          status: statuses[i % statuses.length],
        },
      });
    }
    const rows = await prisma.planDeliverable.findMany({
      where: { planId, slug: { startsWith: 'allowed-ref-' } },
    });
    expect(rows.map((r) => r.refType).sort()).toEqual([...refTypes].sort());
  });

  it('rejects duplicate (plan_id, slug) on every sibling table', async () => {
    await prisma.planConstraint.create({
      data: { planId, slug: 'unique-me', body: 'c1' },
    });
    await expect(
      prisma.planConstraint.create({
        data: { planId, slug: 'unique-me', body: 'c2' },
      }),
    ).rejects.toMatchObject({
      code: 'P2002',
    } satisfies Partial<Prisma.PrismaClientKnownRequestError>);

    await prisma.planStandard.create({
      data: { planId, slug: 'unique-me', body: 's1' },
    });
    await expect(
      prisma.planStandard.create({
        data: { planId, slug: 'unique-me', body: 's2' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('cascade-deletes plan items when the plan is removed and SetNulls supersededById back-pointers', async () => {
    // Create a throw-away plan we are happy to delete.
    const transient = await prisma.plan.create({
      data: {
        projectId,
        version: 2,
        title: 'r150 v2',
        goal: 'g',
        scope: 's',
        status: 'draft',
        createdBy: 'r150-owner',
      },
    });

    const oldDeliverable = await prisma.planDeliverable.create({
      data: {
        planId: transient.id,
        slug: 'auth/oidc-callback',
        title: 'old',
        body: 'old',
      },
    });
    const newDeliverable = await prisma.planDeliverable.create({
      data: {
        planId: transient.id,
        slug: 'auth/oidc-callback-v2',
        title: 'new',
        body: 'new',
        supersededById: oldDeliverable.id,
      },
    });

    // Deleting the *older* (referenced) row must SetNull on the back-pointer,
    // not cascade-delete the newer row.
    await prisma.planDeliverable.delete({ where: { id: oldDeliverable.id } });
    const stillThere = await prisma.planDeliverable.findUnique({
      where: { id: newDeliverable.id },
    });
    expect(stillThere?.supersededById).toBeNull();

    // Deleting the plan cascades and removes both the deliverable and any
    // sibling constraint / standard rows.
    await prisma.planConstraint.create({ data: { planId: transient.id, slug: 'c', body: 'b' } });
    await prisma.planStandard.create({ data: { planId: transient.id, slug: 's', body: 'b' } });
    await prisma.plan.delete({ where: { id: transient.id } });

    expect(await prisma.planDeliverable.count({ where: { planId: transient.id } })).toBe(0);
    expect(await prisma.planConstraint.count({ where: { planId: transient.id } })).toBe(0);
    expect(await prisma.planStandard.count({ where: { planId: transient.id } })).toBe(0);
  });

  it('keeps Plan.show shape unchanged — legacy String[] columns are still the source of truth', async () => {
    // Smoke check: the additive migration must not have rewritten or dropped
    // the legacy array columns. R-151 (the dual-write rollout) is where the
    // structured rows start being treated as canonical; until then plan_show
    // continues to read directly off the arrays.
    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.deliverables).toEqual(['ship the docs', 'ship the api']);
    expect(plan.constraints).toEqual(['no breaking changes']);
    expect(plan.standards).toEqual(['eslint clean']);

    // And the new tables sit alongside without poisoning the legacy shape.
    await prisma.planDeliverable.create({
      data: {
        planId,
        slug: 'shape-check',
        title: 'structured row',
        body: 'b',
      },
    });
    const planAfter = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(planAfter.deliverables).toEqual(['ship the docs', 'ship the api']);
  });
});

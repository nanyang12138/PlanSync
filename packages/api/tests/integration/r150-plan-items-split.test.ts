// R-150: Deliverable / Constraint / Standard 分表 schema.
//
// The new tables are purely additive. This test guards three invariants that
// the migration must hold after `prisma migrate deploy`:
//
//   1. The three tables exist with the expected columns and indexes.
//   2. The legacy `plans.{constraints,standards,deliverables}` String[] shape
//      is still readable from `plan_show` — i.e. existing callers see no
//      behaviour change, which is the whole point of step 6 in the fix plan.
//   3. CRUD on the new tables works end-to-end and the slug uniqueness +
//      cascade-on-plan-delete contracts are enforced by Postgres, not just
//      by the Prisma client.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GET as planGet } from '@/app/api/projects/[projectId]/plans/[planId]/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

type PgIndex = { indexname: string; indexdef: string };
type PgColumn = { column_name: string; data_type: string; is_nullable: string };

async function listIndexes(table: string): Promise<PgIndex[]> {
  return testPrisma.$queryRawUnsafe<PgIndex[]>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
    table,
  );
}

async function listColumns(table: string): Promise<PgColumn[]> {
  return testPrisma.$queryRawUnsafe<PgColumn[]>(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    table,
  );
}

describe('R-150: plan items split tables', () => {
  const owner = 'r150-owner';
  let projectId: string;
  let planId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    ({ planId } = await createActivePlan(projectId, owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('plan_deliverables table has the expected columns', async () => {
    const cols = await listColumns('plan_deliverables');
    const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    for (const required of [
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
    ]) {
      expect(byName[required], `plan_deliverables.${required} missing`).toBeTruthy();
    }
    expect(byName.status.is_nullable).toBe('NO');
    expect(byName.ref_type.is_nullable).toBe('YES');
  });

  it('plan_constraints and plan_standards tables have the expected columns', async () => {
    for (const table of ['plan_constraints', 'plan_standards']) {
      const cols = await listColumns(table);
      const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
      for (const required of ['id', 'plan_id', 'slug', 'body', 'kind', 'created_at']) {
        expect(byName[required], `${table}.${required} missing`).toBeTruthy();
      }
    }
  });

  it('each table carries the (plan_id, slug) unique index', async () => {
    for (const table of ['plan_deliverables', 'plan_constraints', 'plan_standards']) {
      const rows = await listIndexes(table);
      const match = rows.find((r) => r.indexname === `${table}_plan_id_slug_key`);
      expect(
        match,
        `expected unique index on (${table}.plan_id, ${table}.slug); got ${JSON.stringify(
          rows.map((r) => r.indexname),
        )}`,
      ).toBeTruthy();
      expect(match!.indexdef).toMatch(/CREATE\s+UNIQUE\s+INDEX/i);
      expect(match!.indexdef).toMatch(/\(\s*plan_id\s*,\s*slug\s*\)/i);
    }
  });

  it('plan_deliverables has the (plan_id, status) lookup index', async () => {
    const rows = await listIndexes('plan_deliverables');
    const match = rows.find((r) => r.indexname === 'plan_deliverables_plan_id_status_idx');
    expect(match, `expected index on (plan_deliverables.plan_id, status)`).toBeTruthy();
    expect(match!.indexdef).toMatch(/\(\s*plan_id\s*,\s*status\s*\)/i);
  });

  it('plan_show still returns the legacy String[] shape unchanged', async () => {
    const res = await planGet(
      makeReq(`/api/projects/${projectId}/plans/${planId}`, { userName: owner }),
      { params: { projectId, planId } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    // The three String[] columns must still be present so existing callers
    // (plan_show in MCP, CLI, web UI) see no shape change. They default to
    // empty arrays for plans created via the test helper.
    expect(Array.isArray(body.data.constraints)).toBe(true);
    expect(Array.isArray(body.data.standards)).toBe(true);
    expect(Array.isArray(body.data.deliverables)).toBe(true);
  });

  it('CRUD round-trip + (plan_id, slug) uniqueness on plan_deliverables', async () => {
    const created = await testPrisma.planDeliverable.create({
      data: {
        planId,
        slug: 'auth/oidc-callback',
        title: 'OIDC callback handler',
        body: 'Implement /auth/callback endpoint.',
        refType: 'file_glob',
        refUri: 'packages/api/src/app/api/auth/callback/**',
        status: 'active',
      },
    });
    expect(created.id).toBeTruthy();
    expect(created.status).toBe('active');
    expect(created.refType).toBe('file_glob');

    await expect(
      testPrisma.planDeliverable.create({
        data: {
          planId,
          slug: 'auth/oidc-callback',
          title: 'duplicate slug',
          body: 'should fail',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('cascade-on-plan-delete removes child rows in all three tables', async () => {
    const { planId: scratchPlanId } = await createActivePlan(projectId, owner);

    await testPrisma.planDeliverable.create({
      data: { planId: scratchPlanId, slug: 'd1', title: 't', body: 'b' },
    });
    await testPrisma.planConstraint.create({
      data: { planId: scratchPlanId, slug: 'c1', body: 'b', kind: 'security' },
    });
    await testPrisma.planStandard.create({
      data: { planId: scratchPlanId, slug: 's1', body: 'b', kind: 'lint' },
    });

    // Hard-delete the plan and verify Postgres cascaded each child row away.
    await testPrisma.plan.delete({ where: { id: scratchPlanId } });

    expect(await testPrisma.planDeliverable.count({ where: { planId: scratchPlanId } })).toBe(0);
    expect(await testPrisma.planConstraint.count({ where: { planId: scratchPlanId } })).toBe(0);
    expect(await testPrisma.planStandard.count({ where: { planId: scratchPlanId } })).toBe(0);
  });
});

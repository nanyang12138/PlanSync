// R-150: deliverables / constraints / standards are now first-class tables
// (`plan_deliverables`, `plan_constraints`, `plan_standards`) instead of
// String[] columns on `plans`. This test verifies four things in one go:
//
//   1. The new tables exist with the expected columns / indexes.
//   2. Prisma client can CRUD the new models.
//   3. (planId, slug) is unique on each table.
//   4. The legacy String[] columns on `plans` still round-trip — the migration
//      is purely additive (R-150 fix_step #6: "不删旧 String[] 列").
//
// R-151 will later backfill these tables and switch readers to the new shape;
// for now the API's plan_show / plan_update flow must keep returning the old
// String[] shape so existing clients don't break.
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type PgIndex = { indexname: string; indexdef: string };

const cleanupProjects: string[] = [];

async function makeProjectAndPlan(prefix: string) {
  const project = await prisma.project.create({
    data: {
      name: `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      phase: 'planning',
      createdBy: `${prefix}-owner`,
    },
  });
  cleanupProjects.push(project.id);
  const plan = await prisma.plan.create({
    data: {
      projectId: project.id,
      title: `${prefix} v1`,
      goal: 'g',
      scope: 's',
      version: 1,
      status: 'draft',
      createdBy: `${prefix}-owner`,
      // R-150 fix_step #6: legacy String[] columns must keep working.
      deliverables: ['ship login page', 'ship signup page'],
      constraints: ['no third-party trackers'],
      standards: ['eslint clean'],
    },
  });
  return { project, plan };
}

afterAll(async () => {
  for (const id of cleanupProjects) {
    await prisma.project.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
});

describe('R-150: plan items split tables', () => {
  it('creates plan_deliverables / plan_constraints / plan_standards with expected indexes', async () => {
    const rows = await prisma.$queryRawUnsafe<PgIndex[]>(
      `SELECT tablename, indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('plan_deliverables', 'plan_constraints', 'plan_standards')`,
    );
    const findIdx = (table: string, regex: RegExp) =>
      rows.find(
        (r) =>
          (r as { tablename?: string }).tablename === table &&
          regex.test(r.indexdef),
      );

    // (plan_id, slug) uniqueness on every table — R-150 fix_step #2.
    expect(
      findIdx('plan_deliverables', /UNIQUE.*\(\s*plan_id\s*,\s*slug\s*\)/i),
      `expected plan_deliverables unique (plan_id, slug); got ${JSON.stringify(rows)}`,
    ).toBeTruthy();
    expect(
      findIdx('plan_constraints', /UNIQUE.*\(\s*plan_id\s*,\s*slug\s*\)/i),
    ).toBeTruthy();
    expect(
      findIdx('plan_standards', /UNIQUE.*\(\s*plan_id\s*,\s*slug\s*\)/i),
    ).toBeTruthy();

    // (plan_id, status) on plan_deliverables — R-150 fix_step #5.
    expect(
      findIdx('plan_deliverables', /\(\s*plan_id\s*,\s*status\s*\)/i),
      `expected plan_deliverables(plan_id, status) index; got ${JSON.stringify(rows)}`,
    ).toBeTruthy();
  });

  it('Prisma client can CRUD the new PlanDeliverable / PlanConstraint / PlanStandard models', async () => {
    const { plan } = await makeProjectAndPlan('r150-crud');

    const deliverable = await prisma.planDeliverable.create({
      data: {
        planId: plan.id,
        slug: 'auth/oidc-callback',
        title: 'OIDC callback handler',
        body: 'Implement /api/auth/callback that validates id_token',
        refType: 'file_glob',
        refUri: 'packages/api/src/app/api/auth/callback/**',
        status: 'active',
      },
    });
    expect(deliverable.id).toBeTruthy();
    expect(deliverable.status).toBe('active');
    expect(deliverable.refType).toBe('file_glob');

    const constraint = await prisma.planConstraint.create({
      data: {
        planId: plan.id,
        slug: 'no-trackers',
        body: 'No third-party trackers may be added to the auth flow',
        kind: 'security',
      },
    });
    expect(constraint.kind).toBe('security');

    const standard = await prisma.planStandard.create({
      data: {
        planId: plan.id,
        slug: 'eslint-clean',
        body: 'All new files must pass eslint without warnings',
      },
    });
    expect(standard.kind).toBe('general');

    // Supersession self-relation: replace the deliverable with a v2 row and
    // verify the old row points at it.
    const v2 = await prisma.planDeliverable.create({
      data: {
        planId: plan.id,
        slug: 'auth/oidc-callback-v2',
        title: 'OIDC callback handler (v2)',
        body: 'Adds PKCE',
        status: 'active',
      },
    });
    await prisma.planDeliverable.update({
      where: { id: deliverable.id },
      data: { supersededById: v2.id, status: 'deprecated' },
    });
    const refreshed = await prisma.planDeliverable.findUniqueOrThrow({
      where: { id: deliverable.id },
      include: { supersededBy: true },
    });
    expect(refreshed.supersededById).toBe(v2.id);
    expect(refreshed.supersededBy?.slug).toBe('auth/oidc-callback-v2');
    expect(refreshed.status).toBe('deprecated');
  });

  it('rejects duplicate (planId, slug) per table', async () => {
    const { plan } = await makeProjectAndPlan('r150-uniq');

    await prisma.planDeliverable.create({
      data: { planId: plan.id, slug: 'dupe', title: 't', body: 'b' },
    });
    await expect(
      prisma.planDeliverable.create({
        data: { planId: plan.id, slug: 'dupe', title: 't2', body: 'b2' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await prisma.planConstraint.create({
      data: { planId: plan.id, slug: 'c-dupe', body: 'c1' },
    });
    await expect(
      prisma.planConstraint.create({
        data: { planId: plan.id, slug: 'c-dupe', body: 'c2' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await prisma.planStandard.create({
      data: { planId: plan.id, slug: 's-dupe', body: 's1' },
    });
    await expect(
      prisma.planStandard.create({
        data: { planId: plan.id, slug: 's-dupe', body: 's2' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('keeps legacy Plan.deliverables / constraints / standards String[] columns intact', async () => {
    // R-150 fix_step #6 + verification: smoke that the legacy columns still
    // round-trip so plan_show keeps returning the old shape until R-151
    // switches readers to the new tables.
    const { plan } = await makeProjectAndPlan('r150-legacy');
    const refreshed = await prisma.plan.findUniqueOrThrow({
      where: { id: plan.id },
    });
    expect(refreshed.deliverables).toEqual(['ship login page', 'ship signup page']);
    expect(refreshed.constraints).toEqual(['no third-party trackers']);
    expect(refreshed.standards).toEqual(['eslint clean']);
  });

  it('cascades plan_deliverables / constraints / standards on plan delete', async () => {
    const { plan } = await makeProjectAndPlan('r150-cascade');
    await prisma.planDeliverable.create({
      data: { planId: plan.id, slug: 'd1', title: 't', body: 'b' },
    });
    await prisma.planConstraint.create({
      data: { planId: plan.id, slug: 'c1', body: 'c' },
    });
    await prisma.planStandard.create({
      data: { planId: plan.id, slug: 's1', body: 's' },
    });

    await prisma.plan.delete({ where: { id: plan.id } });

    expect(
      await prisma.planDeliverable.count({ where: { planId: plan.id } }),
    ).toBe(0);
    expect(
      await prisma.planConstraint.count({ where: { planId: plan.id } }),
    ).toBe(0);
    expect(
      await prisma.planStandard.count({ where: { planId: plan.id } }),
    ).toBe(0);
  });
});

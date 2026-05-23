/**
 * R-151: dual-write helpers + backfill migration contract tests.
 *
 * Covers:
 *   - slugify pure function (collision-free, index-stable, NFKD)
 *   - writeBoth on a fresh plan: legacy String[] + split table both
 *     populated, content identical, slugs unique
 *   - writeBoth on a partial patch (only one field touched): other
 *     two fields untouched on both sides
 *   - writeBoth on an empty patch: no-op (no transaction even opens)
 *   - writeBoth replaces (not appends): previous split rows are
 *     deleted, second write produces the new set
 *   - writeBoth inside an outer transaction: works without nesting error
 *   - readMerged prefers split-table data when present
 *   - readMerged falls back to legacy String[] when split table is empty
 *     (the pre-backfill / legacy-plan case)
 *   - checkPlanItemsInvariant returns [] after writeBoth (1:1 holds)
 *   - checkPlanItemsInvariant flags a deliberately-induced drift
 *   - backfill migration produces the expected slug pattern for items
 *     that already existed in the legacy arrays at backfill time
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { checkPlanItemsInvariant, readMerged, slugify, writeBoth } from '@/lib/plan-items';

const prisma = new PrismaClient();

const TEST_PROJECT_PREFIX = 'r151-test-';

async function createPlanFixture(
  scenarioId: string,
  arrays: { deliverables?: string[]; constraints?: string[]; standards?: string[] } = {},
): Promise<{ planId: string; projectId: string }> {
  const projectName = `${TEST_PROJECT_PREFIX}${scenarioId}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const project = await prisma.project.create({
    data: {
      name: projectName,
      phase: 'planning',
      createdBy: 'r151-owner',
      members: {
        create: { name: 'r151-owner', role: 'owner', type: 'human' },
      },
    },
  });
  const plan = await prisma.plan.create({
    data: {
      projectId: project.id,
      version: 1,
      status: 'draft',
      title: `r151 ${scenarioId}`,
      goal: 'g',
      scope: 's',
      deliverables: arrays.deliverables ?? [],
      constraints: arrays.constraints ?? [],
      standards: arrays.standards ?? [],
      openQuestions: [],
      createdBy: 'r151-owner',
    },
  });
  return { planId: plan.id, projectId: project.id };
}

async function cleanupTestProjects() {
  // Cascade deletes the plan and split-table rows via FKs.
  await prisma.project.deleteMany({ where: { name: { startsWith: TEST_PROJECT_PREFIX } } });
}

beforeAll(async () => {
  await cleanupTestProjects();
});

afterAll(async () => {
  await cleanupTestProjects();
});

describe('R-151: slugify (pure)', () => {
  it('produces collision-free slugs for duplicate items via the idx suffix', () => {
    const a = slugify('deliverables', 'Implement auth', 0);
    const b = slugify('deliverables', 'Implement auth', 1);
    expect(a).not.toBe(b);
    expect(a).toBe('implement-auth-0');
    expect(b).toBe('implement-auth-1');
  });

  it('normalises Unicode accents via NFKD', () => {
    expect(slugify('deliverables', 'Café déjà-vu', 3)).toBe('cafe-deja-vu-3');
  });

  it('caps slug body at 50 chars before the idx suffix', () => {
    const long = 'a'.repeat(200);
    const slug = slugify('constraints', long, 7);
    // Body capped to 50 chars + '-' + idx.
    expect(slug).toBe('a'.repeat(50) + '-7');
  });

  it('falls back to the field prefix when source has no alphanumeric content', () => {
    expect(slugify('deliverables', '!!!', 0)).toBe('deliverable-0');
    expect(slugify('constraints', '   ', 2)).toBe('constraint-2');
    expect(slugify('standards', '...', 5)).toBe('standard-5');
  });

  it('uses field-specific prefixes', () => {
    expect(slugify('deliverables', '', 0).startsWith('deliverable')).toBe(true);
    expect(slugify('constraints', '', 0).startsWith('constraint')).toBe(true);
    expect(slugify('standards', '', 0).startsWith('standard')).toBe(true);
  });
});

describe('R-151: writeBoth (dual-write)', () => {
  beforeEach(cleanupTestProjects);

  it('populates BOTH legacy String[] AND split table on first call', async () => {
    const { planId } = await createPlanFixture('first-call');
    await writeBoth(planId, {
      deliverables: ['Implement auth', 'Wire up SSE'],
      constraints: ['No external network in tests'],
      standards: ['snake_case for DB columns'],
    });

    const plan = await prisma.plan.findUniqueOrThrow({
      where: { id: planId },
      select: { deliverables: true, constraints: true, standards: true },
    });
    expect(plan.deliverables).toEqual(['Implement auth', 'Wire up SSE']);
    expect(plan.constraints).toEqual(['No external network in tests']);
    expect(plan.standards).toEqual(['snake_case for DB columns']);

    const dRows = await prisma.planDeliverable.findMany({
      where: { planId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(dRows.map((r) => r.title)).toEqual(['Implement auth', 'Wire up SSE']);
    expect(dRows.map((r) => r.slug)).toEqual(['implement-auth-0', 'wire-up-sse-1']);
    expect(dRows.every((r) => r.status === 'active')).toBe(true);
    expect(dRows.every((r) => r.refType === 'free')).toBe(true);

    const cRows = await prisma.planConstraint.findMany({ where: { planId } });
    expect(cRows.map((r) => r.body)).toEqual(['No external network in tests']);
    const sRows = await prisma.planStandard.findMany({ where: { planId } });
    expect(sRows.map((r) => r.body)).toEqual(['snake_case for DB columns']);
  });

  it('partial patch leaves untouched fields alone on BOTH sides', async () => {
    const { planId } = await createPlanFixture('partial', {
      deliverables: ['legacy-d'],
      constraints: ['legacy-c'],
      standards: ['legacy-s'],
    });
    // Touch only constraints.
    await writeBoth(planId, { constraints: ['new-c-1', 'new-c-2'] });

    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.constraints).toEqual(['new-c-1', 'new-c-2']);
    // Untouched legacy arrays.
    expect(plan.deliverables).toEqual(['legacy-d']);
    expect(plan.standards).toEqual(['legacy-s']);
    // Split tables: only constraints touched.
    const dRows = await prisma.planDeliverable.findMany({ where: { planId } });
    const cRows = await prisma.planConstraint.findMany({ where: { planId } });
    const sRows = await prisma.planStandard.findMany({ where: { planId } });
    expect(dRows).toHaveLength(0); // never had a writeBoth call for it
    expect(cRows.map((r) => r.body)).toEqual(['new-c-1', 'new-c-2']);
    expect(sRows).toHaveLength(0);
  });

  it('empty patch is a no-op (no transaction overhead)', async () => {
    const { planId } = await createPlanFixture('empty', { deliverables: ['x'] });
    const before = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    await writeBoth(planId, {});
    const after = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(after.deliverables).toEqual(before.deliverables);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('replaces (not appends): second writeBoth produces the new set, no leftover rows', async () => {
    const { planId } = await createPlanFixture('replace');
    await writeBoth(planId, { deliverables: ['old-1', 'old-2', 'old-3'] });
    await writeBoth(planId, { deliverables: ['new-1'] });

    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.deliverables).toEqual(['new-1']);
    const rows = await prisma.planDeliverable.findMany({ where: { planId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('new-1');
  });

  it('clearing a field (empty array) deletes split rows too', async () => {
    const { planId } = await createPlanFixture('clear');
    await writeBoth(planId, { standards: ['s1', 's2'] });
    await writeBoth(planId, { standards: [] });

    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.standards).toEqual([]);
    const rows = await prisma.planStandard.findMany({ where: { planId } });
    expect(rows).toHaveLength(0);
  });

  it('runs cleanly inside an outer transaction (no nesting error)', async () => {
    const { planId } = await createPlanFixture('outer-tx');
    await prisma.$transaction(async (tx) => {
      await writeBoth(planId, { deliverables: ['tx-1', 'tx-2'] }, tx);
    });
    const rows = await prisma.planDeliverable.findMany({
      where: { planId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(rows.map((r) => r.title)).toEqual(['tx-1', 'tx-2']);
  });
});

describe('R-151: readMerged', () => {
  beforeEach(cleanupTestProjects);

  it('prefers split-table rows when present', async () => {
    const { planId } = await createPlanFixture('prefer-split');
    await writeBoth(planId, { deliverables: ['d1', 'd2'] });
    // Sneak a different value into the legacy array — readMerged should
    // STILL return the split-table value (since split is the new truth).
    await prisma.plan.update({
      where: { id: planId },
      data: { deliverables: ['legacy-only-x'] },
    });

    const merged = await readMerged(planId);
    expect(merged.deliverables).toEqual(['d1', 'd2']);
    expect(merged.sources.deliverables).toBe('split');
  });

  it('falls back to legacy String[] when split table is empty (legacy plan)', async () => {
    const { planId } = await createPlanFixture('legacy-only', {
      deliverables: ['legacy-1', 'legacy-2'],
      constraints: ['legacy-c'],
      standards: [],
    });
    const merged = await readMerged(planId);
    expect(merged.deliverables).toEqual(['legacy-1', 'legacy-2']);
    expect(merged.constraints).toEqual(['legacy-c']);
    expect(merged.standards).toEqual([]);
    expect(merged.sources.deliverables).toBe('legacy_array');
    expect(merged.sources.constraints).toBe('legacy_array');
    expect(merged.sources.standards).toBe('legacy_array');
  });

  it('reports per-field sources independently', async () => {
    const { planId } = await createPlanFixture('mixed-sources', {
      constraints: ['legacy-c'],
    });
    // Only deliverables go through writeBoth.
    await writeBoth(planId, { deliverables: ['new-d'] });

    const merged = await readMerged(planId);
    expect(merged.sources.deliverables).toBe('split');
    expect(merged.sources.constraints).toBe('legacy_array');
    expect(merged.sources.standards).toBe('legacy_array');
  });
});

describe('R-151: checkPlanItemsInvariant', () => {
  beforeEach(cleanupTestProjects);

  it('returns [] after writeBoth (1:1 holds)', async () => {
    const { planId } = await createPlanFixture('invariant-ok');
    await writeBoth(planId, {
      deliverables: ['d-a', 'd-b'],
      constraints: ['c-x'],
      standards: ['s-y', 's-z'],
    });
    expect(await checkPlanItemsInvariant(planId)).toEqual([]);
  });

  it('flags a drift induced by writing the legacy column behind writeBoth', async () => {
    const { planId } = await createPlanFixture('invariant-drift');
    await writeBoth(planId, { deliverables: ['d-a', 'd-b'] });
    // Simulate a write that bypassed writeBoth (the very thing R-151
    // wants to make impossible after R-152 lands).
    await prisma.plan.update({
      where: { id: planId },
      data: { deliverables: ['d-a', 'd-b-DRIFTED'] },
    });

    const mismatches = await checkPlanItemsInvariant(planId);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      field: 'deliverables',
      legacyLength: 2,
      splitLength: 2,
      firstDivergenceIdx: 1,
    });
  });

  it('flags a length mismatch with firstDivergenceIdx: null', async () => {
    const { planId } = await createPlanFixture('invariant-length');
    await writeBoth(planId, { constraints: ['c1', 'c2', 'c3'] });
    await prisma.plan.update({
      where: { id: planId },
      data: { constraints: ['c1'] }, // shrank the legacy side
    });

    const mismatches = await checkPlanItemsInvariant(planId);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      field: 'constraints',
      legacyLength: 1,
      splitLength: 3,
      firstDivergenceIdx: null,
    });
  });

  it('does not flag legacy-only plans (split rows missing is the expected legacy state)', async () => {
    const { planId } = await createPlanFixture('invariant-legacy-only', {
      deliverables: ['L1', 'L2'],
    });
    expect(await checkPlanItemsInvariant(planId)).toEqual([]);
  });
});

describe('R-151: backfill migration produces deterministic legacy-style slugs', () => {
  beforeEach(cleanupTestProjects);

  it('re-running the backfill SQL is idempotent (ON CONFLICT DO NOTHING)', async () => {
    // Create a plan with legacy data; manually trigger the same INSERT that
    // the migration runs to confirm it produces the expected `deliverable-N`
    // slugs and is idempotent.
    const { planId } = await createPlanFixture('backfill', {
      deliverables: ['Migrate plan items', 'Backfill split tables'],
    });

    // Wipe whatever split rows the test setup created (none, since this
    // plan was inserted via prisma.plan.create, not writeBoth).
    await prisma.planDeliverable.deleteMany({ where: { planId } });

    // Run the backfill SQL twice — second run should be a no-op.
    for (let i = 0; i < 2; i++) {
      await prisma.$executeRawUnsafe(`
        INSERT INTO "plan_deliverables"
          ("id", "plan_id", "slug", "title", "body", "ref_type", "status", "created_at")
        SELECT
          'r151_' || substr(md5(p.id || '|deliverable-' || (idx - 1)::text), 1, 20),
          p.id,
          'deliverable-' || (idx - 1)::text,
          item,
          item,
          'free',
          'active',
          CURRENT_TIMESTAMP
        FROM "plans" p
        CROSS JOIN LATERAL unnest(p.deliverables) WITH ORDINALITY AS arr(item, idx)
        WHERE p.id = '${planId}'
          AND p.deliverables IS NOT NULL
          AND array_length(p.deliverables, 1) > 0
        ON CONFLICT ("plan_id", "slug") DO NOTHING;
      `);
    }

    const rows = await prisma.planDeliverable.findMany({
      where: { planId },
      orderBy: { slug: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.slug).sort()).toEqual(['deliverable-0', 'deliverable-1']);
    expect(rows.map((r) => r.title).sort()).toEqual(
      ['Backfill split tables', 'Migrate plan items'].sort(),
    );
    // Stable id pattern: matches r151_<20 hex>.
    for (const r of rows) {
      expect(r.id).toMatch(/^r151_[0-9a-f]{20}$/);
    }
  });
});

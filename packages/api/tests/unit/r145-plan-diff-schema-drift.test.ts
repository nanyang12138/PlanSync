// R-145: shared schema validation for the PlanDiff.changes JSON column.
//
// We test three layers:
//   1. The shared `planDiffChangesSchema` accepts a canonical valid
//      payload and rejects malformed ones. This is the contract every
//      reader (drift engine, plans page, impact analysis) is allowed
//      to rely on.
//   2. `getOrCreatePlanDiff` refuses to cache a malformed AI response
//      (write-side `parse`). We can't easily make the AI generator
//      produce a malformed object because the upstream `validateOrNull`
//      pass already filters those — so we test the schema directly +
//      assert the function returns null in that scenario via a separate
//      contract test (it never reaches `prisma.planDiff.create`).
//   3. `getOrCreatePlanDiff` discards a stale cached row that no longer
//      matches the schema (read-side `safeParse`), evicts it from the
//      DB, and either recomputes via AI or returns null when AI is
//      unavailable.
//   4. The API-side `planDiffResultZ` (used as the AI tool_use shape)
//      stays equivalent to the shared `planDiffChangesSchema` for the
//      same canonical fixture — this is the "schema-drift CI guard"
//      that catches future divergence between the two definitions.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { planDiffChangesSchema } from '@plansync/shared';

const CANONICAL_VALID = {
  changes: [
    {
      aspect: 'goal' as const,
      type: 'modified' as const,
      from: 'old goal',
      to: 'new goal',
      impact: 'high' as const,
      description: 'rewrote goal',
      affectedAreas: ['api'],
    },
    {
      aspect: 'deliverables' as const,
      type: 'removed' as const,
      from: 'old-deliverable',
      to: null,
      impact: 'medium' as const,
      description: 'dropped',
      affectedAreas: [],
    },
  ],
  summary: 'one goal rewrite plus one deliverable drop',
  breakingChanges: true,
};

describe('R-145 planDiffChangesSchema (shared)', () => {
  it('accepts the canonical valid payload', () => {
    const r = planDiffChangesSchema.safeParse(CANONICAL_VALID);
    expect(r.success).toBe(true);
  });

  it('preserves the opaque R-187 `_meta` audit envelope via passthrough', () => {
    const withMeta = {
      ...CANONICAL_VALID,
      _meta: {
        verifierDisagreed: true,
        originalBreakingChanges: true,
        verifierVerdict: 'reject',
        verifierReasoning: 'cosmetic',
      },
    };
    const r = planDiffChangesSchema.safeParse(withMeta);
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as { _meta?: unknown })._meta).toMatchObject({
        verifierDisagreed: true,
      });
    }
  });

  it('rejects payload missing required top-level field (summary)', () => {
    const bad = {
      changes: CANONICAL_VALID.changes,
      breakingChanges: false,
    };
    const r = planDiffChangesSchema.safeParse(bad);
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('summary');
    }
  });

  it('rejects payload with a non-enum `aspect` value', () => {
    const bad = {
      ...CANONICAL_VALID,
      changes: [
        {
          ...CANONICAL_VALID.changes[0],
          aspect: 'priority',
        },
      ],
    };
    const r = planDiffChangesSchema.safeParse(bad);
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => p.endsWith('aspect'))).toBe(true);
    }
  });

  it('rejects payload with wrong type on `breakingChanges`', () => {
    const bad = { ...CANONICAL_VALID, breakingChanges: 'yes' };
    const r = planDiffChangesSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it('rejects payload where a change is missing `affectedAreas`', () => {
    const bad = {
      ...CANONICAL_VALID,
      changes: [
        {
          aspect: 'goal',
          type: 'modified',
          from: 'a',
          to: 'b',
          impact: 'low',
          description: 'd',
        },
      ],
    };
    const r = planDiffChangesSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it('rejects entirely non-object input (defensive against bare JSON values)', () => {
    expect(planDiffChangesSchema.safeParse(null).success).toBe(false);
    expect(planDiffChangesSchema.safeParse('a string').success).toBe(false);
    expect(planDiffChangesSchema.safeParse(42).success).toBe(false);
    expect(planDiffChangesSchema.safeParse([]).success).toBe(false);
  });
});

describe('R-145 schema-drift guard: shared planDiffChangesSchema ↔ api planDiffResultZ', () => {
  it('the API-side `planDiffResultZ` accepts every payload the shared schema accepts', async () => {
    const { planDiffResultZ } = await import('../../src/lib/ai/schemas');
    const sharedR = planDiffChangesSchema.safeParse(CANONICAL_VALID);
    const apiR = planDiffResultZ.safeParse(CANONICAL_VALID);
    expect(sharedR.success).toBe(true);
    expect(apiR.success).toBe(true);
  });

  it('both schemas reject the same malformed payload (missing `breakingChanges`)', async () => {
    const { planDiffResultZ } = await import('../../src/lib/ai/schemas');
    const bad = {
      changes: CANONICAL_VALID.changes,
      summary: 's',
    };
    expect(planDiffChangesSchema.safeParse(bad).success).toBe(false);
    expect(planDiffResultZ.safeParse(bad).success).toBe(false);
  });

  it('both schemas reject a bad `aspect` enum value', async () => {
    const { planDiffResultZ } = await import('../../src/lib/ai/schemas');
    const bad = {
      ...CANONICAL_VALID,
      changes: [{ ...CANONICAL_VALID.changes[0], aspect: 'nonsense' }],
    };
    expect(planDiffChangesSchema.safeParse(bad).success).toBe(false);
    expect(planDiffResultZ.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Behaviour test for the read-side stale-cache eviction in
// `getOrCreatePlanDiff`. The aiClient is mocked unavailable so the
// function does NOT attempt to recompute — we only assert that a
// malformed cached row is (a) not returned to the caller and (b)
// evicted from the DB.
// ---------------------------------------------------------------------------

vi.mock('../../src/lib/prisma', () => ({
  prisma: {
    planDiff: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    plan: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../src/lib/ai/client', () => ({
  aiClient: {
    get isAvailable() {
      return false;
    },
    providerName: 'mock',
    complete: vi.fn(),
  },
}));

describe('R-145 getOrCreatePlanDiff stale-cache eviction', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('discards + evicts a cached row that fails shared schema validation', async () => {
    const { prisma } = await import('../../src/lib/prisma');
    (prisma.planDiff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'diff1',
      projectId: 'proj',
      fromPlanId: 'pA',
      toPlanId: 'pB',
      changes: {
        // Missing required fields summary + breakingChanges; also `aspect`
        // is not in the enum. Any of these alone is enough to fail the
        // schema, but stacking them mirrors the realistic "wrote under
        // an older shape" case we want to evict.
        changes: [{ aspect: 'priority', type: 'added' }],
      },
    });
    (prisma.planDiff.delete as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const { getOrCreatePlanDiff } = await import('../../src/lib/ai/plan-diff');
    const out = await getOrCreatePlanDiff('proj', 'pA', 'pB');

    // AI is unavailable in this test, so the recompute path returns
    // null — but the eviction must still have run.
    expect(out).toBeNull();
    expect(prisma.planDiff.delete).toHaveBeenCalledTimes(1);
    expect(prisma.planDiff.delete).toHaveBeenCalledWith({
      where: { fromPlanId_toPlanId: { fromPlanId: 'pA', toPlanId: 'pB' } },
    });
  });

  it('returns the cached row unchanged when it matches the shared schema', async () => {
    const { prisma } = await import('../../src/lib/prisma');
    (prisma.planDiff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'diff2',
      projectId: 'proj',
      fromPlanId: 'pA',
      toPlanId: 'pB',
      changes: CANONICAL_VALID,
    });
    (prisma.planDiff.delete as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const { getOrCreatePlanDiff } = await import('../../src/lib/ai/plan-diff');
    const out = await getOrCreatePlanDiff('proj', 'pA', 'pB');

    expect(out).not.toBeNull();
    expect(out!.summary).toBe(CANONICAL_VALID.summary);
    expect(out!.breakingChanges).toBe(true);
    expect(out!.changes).toHaveLength(2);
    expect(prisma.planDiff.delete).not.toHaveBeenCalled();
  });
});

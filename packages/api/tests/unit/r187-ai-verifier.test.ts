// R-187: LLM-as-Judge second pass for plan-diff breakingChanges and
// impact-analysis cancel.
//
// We stub `aiClient.complete` so the verifier's second LLM call returns
// deterministic verdicts, then exercise both callers end-to-end:
//   * plan-diff: candidate breakingChanges=true + verdict=reject →
//     downgrade to false + write `_meta.verifierDisagreed=true`
//   * plan-diff: candidate breakingChanges=true + verdict=agree → keep
//   * plan-diff: candidate breakingChanges=false → verifier never runs
//   * impact-analysis: candidate cancel + verdict=reject → downgrade to
//     rebind + append verifier reasoning to affectedAreas
//   * impact-analysis: candidate cancel + verdict=agree → keep
//   * impact-analysis: candidate no_impact → verifier never runs

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the prisma layer so plan-diff doesn't actually hit PG.
vi.mock('../../src/lib/prisma', () => ({
  prisma: {
    planDiff: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    plan: {
      findUnique: vi.fn(),
    },
  },
}));

// Mock aiClient.complete with a scriptable per-purpose router so we can
// distinguish the generator call (purpose: 'plan_diff' /
// 'drift_impact') from the verifier call ('verifier_plan_diff_breaking'
// / 'verifier_impact_cancel').
const { completeMock } = vi.hoisted(() => ({ completeMock: vi.fn() }));

vi.mock('../../src/lib/ai/client', () => ({
  aiClient: {
    get isAvailable() {
      return true;
    },
    providerName: 'mock',
    complete: completeMock,
  },
}));

beforeEach(() => {
  completeMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeCompleteRouter(map: Record<string, string>) {
  return (
    _system: string,
    _user: string,
    opts: { purpose: string } | string | undefined,
  ) => {
    const purpose = typeof opts === 'string' ? opts : opts?.purpose ?? '';
    return Promise.resolve(map[purpose] ?? null);
  };
}

describe('R-187 plan-diff breaking-change verifier', () => {
  it('downgrades breakingChanges=true when verdict=reject and stamps _meta', async () => {
    const { prisma } = await import('../../src/lib/prisma');
    (prisma.planDiff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.plan.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: 'pA',
        projectId: 'proj',
        goal: 'A goal',
        scope: 'A scope',
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
      })
      .mockResolvedValueOnce({
        id: 'pB',
        projectId: 'proj',
        goal: 'B goal',
        scope: 'B scope',
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
      });
    let capturedCreatePayload: unknown = null;
    (prisma.planDiff.create as ReturnType<typeof vi.fn>).mockImplementation(
      ({ data }: { data: unknown }) => {
        capturedCreatePayload = data;
        return Promise.resolve({});
      },
    );

    completeMock.mockImplementation(
      makeCompleteRouter({
        plan_diff: JSON.stringify({
          changes: [
            {
              aspect: 'goal',
              type: 'modified',
              from: 'A goal',
              to: 'B goal',
              impact: 'high',
              description: 'rewrote goal',
              affectedAreas: ['api'],
            },
          ],
          summary: 'goal rewrite',
          breakingChanges: true,
        }),
        verifier_plan_diff_breaking: JSON.stringify({
          verdict: 'reject',
          reasoning: 'the change is cosmetic; not breaking',
        }),
      }),
    );

    const { getOrCreatePlanDiff } = await import('../../src/lib/ai/plan-diff');
    const out = await getOrCreatePlanDiff('proj', 'pA', 'pB');

    expect(out).not.toBeNull();
    expect(out!.breakingChanges).toBe(false);
    expect((out as { _meta?: Record<string, unknown> })._meta).toMatchObject({
      verifierDisagreed: true,
      originalBreakingChanges: true,
      verifierVerdict: 'reject',
    });
    expect(
      (capturedCreatePayload as { changes: { breakingChanges: boolean } }).changes.breakingChanges,
    ).toBe(false);
  });

  it('keeps breakingChanges=true when verdict=agree', async () => {
    const { prisma } = await import('../../src/lib/prisma');
    (prisma.planDiff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.plan.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: 'pA',
        projectId: 'p',
        goal: 'g',
        scope: 's',
        constraints: [],
        standards: [],
        deliverables: ['old-deliverable'],
        openQuestions: [],
      })
      .mockResolvedValueOnce({
        id: 'pB',
        projectId: 'p',
        goal: 'g',
        scope: 's',
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
      });
    (prisma.planDiff.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    completeMock.mockImplementation(
      makeCompleteRouter({
        plan_diff: JSON.stringify({
          changes: [
            {
              aspect: 'deliverables',
              type: 'removed',
              from: 'old-deliverable',
              to: null,
              impact: 'high',
              description: 'dropped a deliverable',
              affectedAreas: ['scope'],
            },
          ],
          summary: 'deliverable removed',
          breakingChanges: true,
        }),
        verifier_plan_diff_breaking: JSON.stringify({
          verdict: 'agree',
          reasoning: 'removing a deliverable is breaking',
        }),
      }),
    );

    const { getOrCreatePlanDiff } = await import('../../src/lib/ai/plan-diff');
    const out = await getOrCreatePlanDiff('p', 'pA', 'pB');

    expect(out!.breakingChanges).toBe(true);
    expect((out as { _meta?: unknown })._meta).toBeUndefined();
  });

  it('skips the verifier entirely when breakingChanges=false', async () => {
    const { prisma } = await import('../../src/lib/prisma');
    (prisma.planDiff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.plan.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: 'pA',
        projectId: 'p',
        goal: 'g',
        scope: 's',
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
      })
      .mockResolvedValueOnce({
        id: 'pB',
        projectId: 'p',
        goal: 'g',
        scope: 's',
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
      });
    (prisma.planDiff.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    completeMock.mockImplementation(
      makeCompleteRouter({
        plan_diff: JSON.stringify({
          changes: [],
          summary: 'no real changes',
          breakingChanges: false,
        }),
      }),
    );

    const { getOrCreatePlanDiff } = await import('../../src/lib/ai/plan-diff');
    const out = await getOrCreatePlanDiff('p', 'pA', 'pB');

    expect(out!.breakingChanges).toBe(false);
    const verifierCalls = completeMock.mock.calls.filter((c) => {
      const opts = c[2];
      const purpose = typeof opts === 'string' ? opts : opts?.purpose;
      return purpose === 'verifier_plan_diff_breaking';
    });
    expect(verifierCalls).toHaveLength(0);
  });
});

describe('R-187 impact-analysis cancel verifier', () => {
  it('downgrades suggestedAction=cancel to rebind on verdict=reject', async () => {
    completeMock.mockImplementation(
      makeCompleteRouter({
        drift_impact: JSON.stringify({
          compatibilityScore: 20,
          compatible: false,
          suggestedAction: 'cancel',
          reasoning: 'looks bad',
          affectedAreas: ['api'],
          riskLevel: 'high',
        }),
        verifier_impact_cancel: JSON.stringify({
          verdict: 'reject',
          reasoning: 'task scope still applies; rebind is safer',
        }),
      }),
    );

    const { analyzeTaskImpact } = await import('../../src/lib/ai/impact-analysis');
    const out = await analyzeTaskImpact(
      { changes: [], summary: 's', breakingChanges: false } as never,
      {
        title: 'task',
        type: 'code',
        status: 'in_progress',
        boundPlanVersion: 1,
      },
    );

    expect(out).not.toBeNull();
    expect(out!.suggestedAction).toBe('rebind');
    expect(out!.affectedAreas.some((a) => a.includes('[verifier:reject]'))).toBe(true);
    expect(out!.affectedAreas.some((a) => a.includes('rebind is safer'))).toBe(true);
  });

  it('keeps suggestedAction=cancel when verdict=agree', async () => {
    completeMock.mockImplementation(
      makeCompleteRouter({
        drift_impact: JSON.stringify({
          compatibilityScore: 10,
          compatible: false,
          suggestedAction: 'cancel',
          reasoning: 'incompatible',
          affectedAreas: [],
          riskLevel: 'high',
        }),
        verifier_impact_cancel: JSON.stringify({
          verdict: 'agree',
          reasoning: 'the constraint is gone; cancel is correct',
        }),
      }),
    );

    const { analyzeTaskImpact } = await import('../../src/lib/ai/impact-analysis');
    const out = await analyzeTaskImpact(
      { changes: [], summary: 's', breakingChanges: false } as never,
      { title: 't', status: 'in_progress', boundPlanVersion: 1 },
    );

    expect(out!.suggestedAction).toBe('cancel');
  });

  it('skips the verifier entirely when suggestedAction !== cancel', async () => {
    completeMock.mockImplementation(
      makeCompleteRouter({
        drift_impact: JSON.stringify({
          compatibilityScore: 80,
          compatible: true,
          suggestedAction: 'no_impact',
          reasoning: 'fine',
          affectedAreas: [],
          riskLevel: 'low',
        }),
      }),
    );

    const { analyzeTaskImpact } = await import('../../src/lib/ai/impact-analysis');
    const out = await analyzeTaskImpact(
      { changes: [], summary: 's', breakingChanges: false } as never,
      { title: 't', status: 'in_progress', boundPlanVersion: 1 },
    );

    expect(out!.suggestedAction).toBe('no_impact');
    const verifierCalls = completeMock.mock.calls.filter((c) => {
      const opts = c[2];
      const purpose = typeof opts === 'string' ? opts : opts?.purpose;
      return purpose === 'verifier_impact_cancel';
    });
    expect(verifierCalls).toHaveLength(0);
  });

  it('leaves cancel in place when verifier returns null (could not verify)', async () => {
    completeMock.mockImplementation(
      makeCompleteRouter({
        drift_impact: JSON.stringify({
          compatibilityScore: 20,
          compatible: false,
          suggestedAction: 'cancel',
          reasoning: 'no',
          affectedAreas: [],
          riskLevel: 'high',
        }),
        // Note: no verifier_impact_cancel entry → router returns null
      }),
    );

    const { analyzeTaskImpact } = await import('../../src/lib/ai/impact-analysis');
    const out = await analyzeTaskImpact(
      { changes: [], summary: 's', breakingChanges: false } as never,
      { title: 't', status: 'in_progress', boundPlanVersion: 1 },
    );

    expect(out!.suggestedAction).toBe('cancel');
  });
});

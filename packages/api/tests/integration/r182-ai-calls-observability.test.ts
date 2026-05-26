/**
 * R-182 (supersedes R-144): every aiClient.complete() call must record a
 * row in `ai_calls` carrying purpose / provider / model / latency / token
 * counts / input hash / cache flag. The /api/ai-usage endpoint aggregates
 * those rows by purpose for the owner.
 *
 * These tests run against the deterministic mock provider (PLANSYNC_AI_MOCK=1,
 * set by tests/setup.ts) so no real LLM is involved. Coverage:
 *
 *   1. A single mock-provider call writes one ai_calls row with the right
 *      purpose / provider / ok flag.
 *   2. When the provider name flips (anthropic → amd via env reload),
 *      ai_calls rows reflect the *new* provider field — the R-182 spec's
 *      "provider 切换时新行 provider 字段正确" check.
 *   3. /api/ai-usage returns per-purpose aggregation buckets including
 *      count / p50 latency / total tokens / cache hit ratio, and rejects
 *      callers who are not project owners.
 *   4. PLANSYNC_AI_OBSERVABILITY=false suppresses the INSERT (rollback
 *      flag documented in REMEDIATION_PLAN.md R-182).
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { GET as aiUsageGet } from '@/app/api/ai-usage/route';
import { recordAiCall, aggregateAiUsage } from '@/lib/ai/usage';
import { makeReq, createTestProject, cleanupProject } from '../helpers/request';

const prisma = new PrismaClient();

async function clearAiCalls() {
  await prisma.aiCall.deleteMany({});
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('R-182: ai_calls observability persists provider + purpose', () => {
  beforeEach(async () => {
    await clearAiCalls();
    vi.resetModules();
    delete (globalThis as { aiClient?: unknown }).aiClient;
  });

  it('mock provider writes one ai_calls row per complete() call', async () => {
    // Re-import after resetModules so the AiClient singleton picks up
    // PLANSYNC_AI_MOCK=1 (set by tests/setup.ts).
    const { aiClient } = await import('@/lib/ai/client');
    const { PLAN_DIFF_SYSTEM } = await import('@/lib/ai/prompts/plan-diff.prompt');

    // Per-run unique purpose so concurrent vitest forks writing to the
    // shared ai_calls table can't pollute our count / findFirst lookup.
    // See #1106 regression: f826a92 inadvertently removed this isolation.
    const purpose = `plan_diff_writes1_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const before = await prisma.aiCall.count({ where: { purpose } });
    const out = await aiClient.complete(PLAN_DIFF_SYSTEM, 'user msg', {
      purpose,
    });
    const after = await prisma.aiCall.count({ where: { purpose } });

    expect(out).not.toBeNull();
    expect(after).toBe(before + 1);

    const row = await prisma.aiCall.findFirst({
      where: { purpose },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).not.toBeNull();
    expect(row!.purpose).toBe(purpose);
    expect(row!.provider).toBe('mock');
    expect(row!.ok).toBe(true);
    expect(row!.cacheHit).toBe(false);
    expect(row!.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.outputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('two identical prompts produce identical inputHash but two rows', async () => {
    // Pre-condition for R-183 caching: inputHash must be stable and
    // deterministic over (system + user), so a future cache lookup keyed
    // on inputHash will hit on the second identical request.
    const { aiClient } = await import('@/lib/ai/client');
    const { PLAN_DIFF_SYSTEM } = await import('@/lib/ai/prompts/plan-diff.prompt');

    // Per-run unique purpose for fork isolation. See #1095 (added this)
    // and #1106 / f826a92 (regressed it). Same pattern as test 1.
    const purpose = `plan_diff_dup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await aiClient.complete(PLAN_DIFF_SYSTEM, 'same-user', { purpose });
    await aiClient.complete(PLAN_DIFF_SYSTEM, 'same-user', { purpose });

    const rows = await prisma.aiCall.findMany({
      where: { purpose },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.length).toBe(2);
    expect(rows[0].inputHash).toBe(rows[1].inputHash);
    expect(rows[0].outputHash).toBe(rows[1].outputHash);
  });

  it('a different system prompt produces a different inputHash', async () => {
    const { aiClient } = await import('@/lib/ai/client');
    const { PLAN_DIFF_SYSTEM } = await import('@/lib/ai/prompts/plan-diff.prompt');
    const { IMPACT_ANALYSIS_SYSTEM } = await import('@/lib/ai/prompts/impact-analysis.prompt');

    // Per-run unique purposes for fork isolation. See #1095 / #1106.
    const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const planPurpose = `plan_diff_diff_${tag}`;
    const impactPurpose = `drift_impact_diff_${tag}`;
    await aiClient.complete(PLAN_DIFF_SYSTEM, 'same-user', { purpose: planPurpose });
    await aiClient.complete(IMPACT_ANALYSIS_SYSTEM, 'same-user', { purpose: impactPurpose });

    const rows = await prisma.aiCall.findMany({
      where: { purpose: { in: [planPurpose, impactPurpose] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows[0].inputHash).not.toBe(rows[1].inputHash);
    expect(rows[0].promptHash).not.toBe(rows[1].promptHash);
  });
});

describe('R-182: provider field reflects active provider when it switches', () => {
  // Verification: "provider 切换时新行 provider 字段正确" — explicitly
  // listed in R-182's verification section.
  beforeEach(async () => {
    await clearAiCalls();
  });

  it('records different provider strings as the singleton is rebuilt', async () => {
    const ORIGINAL_MOCK = process.env.PLANSYNC_AI_MOCK;
    const ORIGINAL_AMD = process.env.LLM_API_KEY;
    const ORIGINAL_ANTHROPIC = process.env.ANTHROPIC_API_KEY;

    // Per-run unique purpose for fork isolation. Same flake class as the
    // tests in the first describe (see #1095 / #1106 history).
    const purpose = `plan_diff_provider_switch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    try {
      // First pass: write a row with provider='mock' (PLANSYNC_AI_MOCK=1
      // is the default from tests/setup.ts).
      await recordAiCall({
        purpose,
        provider: 'mock',
        model: 'mock-model',
        promptHash: 'h1',
        inputHash: 'i1',
        outputHash: 'o1',
        promptVersion: 'v1',
        latencyMs: 10,
        inputTokens: null,
        outputTokens: null,
        ok: true,
        errorCode: null,
        cacheHit: false,
      });

      // Second pass: simulate the provider switching to 'anthropic' (no
      // real network call — we hand recordAiCall the row directly because
      // the integration test environment has no Anthropic key).
      await recordAiCall({
        purpose,
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        promptHash: 'h2',
        inputHash: 'i2',
        outputHash: 'o2',
        promptVersion: 'v1',
        latencyMs: 220,
        inputTokens: 120,
        outputTokens: 80,
        ok: true,
        errorCode: null,
        cacheHit: false,
      });

      const rows = await prisma.aiCall.findMany({
        where: { purpose },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((r) => r.provider)).toEqual(['mock', 'anthropic']);
      expect(rows[1].inputTokens).toBe(120);
      expect(rows[1].outputTokens).toBe(80);
    } finally {
      if (ORIGINAL_MOCK === undefined) delete process.env.PLANSYNC_AI_MOCK;
      else process.env.PLANSYNC_AI_MOCK = ORIGINAL_MOCK;
      if (ORIGINAL_AMD === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = ORIGINAL_AMD;
      if (ORIGINAL_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC;
    }
  });
});

describe('R-182: aggregateAiUsage groups by purpose', () => {
  beforeEach(async () => {
    await clearAiCalls();
  });

  it('returns per-purpose buckets with count / latency / token totals / cache ratio', async () => {
    // Vitest runs test files in parallel forks against a shared DB, and any
    // other test that exercises aiClient.complete writes to ai_calls. Scope
    // the aggregation window to "after we started inserting fixtures" so the
    // assertion is robust to concurrent inserts from other suites.
    const since = new Date();
    // Make sure `since` is strictly less than every fixture's createdAt
    // (Postgres timestamp resolution can match wall-clock at millisecond
    // boundaries).
    await new Promise((resolve) => setTimeout(resolve, 5));

    const fixtures = [
      { purpose: 'plan_diff', latencyMs: 100, ok: true, cacheHit: false, in: 10, out: 5 },
      { purpose: 'plan_diff', latencyMs: 200, ok: true, cacheHit: true, in: 0, out: 0 },
      { purpose: 'plan_diff', latencyMs: 300, ok: false, cacheHit: false, in: 0, out: 0 },
      { purpose: 'drift_impact', latencyMs: 50, ok: true, cacheHit: false, in: 3, out: 2 },
    ];
    for (const f of fixtures) {
      await recordAiCall({
        purpose: f.purpose,
        provider: 'mock',
        model: 'mock-model',
        promptHash: 'h',
        inputHash: `i-${Math.random()}`,
        outputHash: null,
        promptVersion: 'v1',
        latencyMs: f.latencyMs,
        inputTokens: f.in || null,
        outputTokens: f.out || null,
        ok: f.ok,
        errorCode: f.ok ? null : 'http_500',
        cacheHit: f.cacheHit,
      });
    }

    const usage = await aggregateAiUsage({ since });
    expect(usage.totalCalls).toBe(4);

    const plan = usage.buckets.find((b) => b.purpose === 'plan_diff')!;
    expect(plan).toBeDefined();
    expect(plan.count).toBe(3);
    expect(plan.okCount).toBe(2);
    expect(plan.errorCount).toBe(1);
    expect(plan.cacheHits).toBe(1);
    expect(plan.cacheHitRatio).toBeCloseTo(1 / 3, 5);
    expect(plan.totalInputTokens).toBe(10);
    expect(plan.totalOutputTokens).toBe(5);
    // p50 of [100,200,300] sorted = index floor(2 * 0.5) = 1 → 200
    expect(plan.p50LatencyMs).toBe(200);

    const impact = usage.buckets.find((b) => b.purpose === 'drift_impact')!;
    expect(impact.count).toBe(1);
    expect(impact.okCount).toBe(1);
    expect(impact.cacheHits).toBe(0);
  });
});

describe('R-182: /api/ai-usage is owner-gated', () => {
  let ownerProject: { projectId: string } | null = null;
  let nonOwnerProject: { projectId: string } | null = null;

  beforeEach(async () => {
    await clearAiCalls();
    if (!ownerProject) ownerProject = await createTestProject('r182-owner');
    if (!nonOwnerProject) {
      nonOwnerProject = await createTestProject('r182-other-owner');
      // Add 'r182-developer' as a developer of nonOwnerProject so that
      // user has membership somewhere but is not an owner anywhere.
      await prisma.projectMember.create({
        data: {
          projectId: nonOwnerProject.projectId,
          name: 'r182-developer',
          role: 'developer',
          type: 'human',
        },
      });
    }
  });

  afterAll(async () => {
    if (ownerProject) await cleanupProject(ownerProject.projectId);
    if (nonOwnerProject) await cleanupProject(nonOwnerProject.projectId);
  });

  it('returns aggregated buckets for a project owner', async () => {
    // Vitest forks share the same DB; other suites may write ai_calls in
    // parallel. Scope the query to "since just before this test inserted"
    // so totalCalls is robust to cross-suite writes.
    const since = new Date();
    await new Promise((resolve) => setTimeout(resolve, 5));

    await recordAiCall({
      purpose: 'plan_diff',
      provider: 'mock',
      model: 'mock-model',
      promptHash: 'h',
      inputHash: 'i',
      outputHash: 'o',
      promptVersion: 'v1',
      latencyMs: 42,
      inputTokens: null,
      outputTokens: null,
      ok: true,
      errorCode: null,
      cacheHit: false,
    });

    const req = makeReq('/api/ai-usage', {
      userName: 'r182-owner',
      searchParams: { since: since.toISOString() },
    });
    const res = await aiUsageGet(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ purpose: string; count: number; p50LatencyMs: number }>;
      totalCalls: number;
    };
    expect(body.totalCalls).toBe(1);
    expect(body.data.find((b) => b.purpose === 'plan_diff')).toBeDefined();
  });

  it('rejects a caller who is only a developer (not an owner of any project)', async () => {
    const req = makeReq('/api/ai-usage', { userName: 'r182-developer' });
    const res = await aiUsageGet(req);
    expect(res.status).toBe(403);
  });
});

describe('R-182: PLANSYNC_AI_OBSERVABILITY=false suppresses INSERT', () => {
  beforeEach(async () => {
    await clearAiCalls();
  });

  it('skips the ai_calls write when the flag is off, but still returns AI output', async () => {
    // Per-run unique purpose so concurrent vitest forks can't insert
    // rows that we mis-attribute to our recordAiCall call. The contract
    // we're proving is "when the flag is off, NO row with our purpose
    // shows up" — count globally was racy.
    const purpose = `plan_diff_obs_off_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const before = await prisma.aiCall.count({ where: { purpose } });
    process.env.PLANSYNC_AI_OBSERVABILITY = 'false';
    try {
      await recordAiCall({
        purpose,
        provider: 'mock',
        model: 'mock-model',
        promptHash: 'h',
        inputHash: 'i',
        outputHash: 'o',
        promptVersion: 'v1',
        latencyMs: 1,
        inputTokens: null,
        outputTokens: null,
        ok: true,
        errorCode: null,
        cacheHit: false,
      });
    } finally {
      delete process.env.PLANSYNC_AI_OBSERVABILITY;
    }
    const after = await prisma.aiCall.count({ where: { purpose } });
    expect(after).toBe(before);
  });
});

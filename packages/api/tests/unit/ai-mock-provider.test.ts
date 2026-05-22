// R-124: verifies the AI mock provider — both the response dispatcher and the
// AiClient end-to-end path that consumes it. CI runs with PLANSYNC_AI_MOCK=1
// by default (tests/setup.ts) so the ai integration tests no longer skip.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMockAiResponse } from '../../src/lib/ai/mock-responses';
import { PLAN_DIFF_SYSTEM } from '../../src/lib/ai/prompts/plan-diff.prompt';
import { IMPACT_ANALYSIS_SYSTEM } from '../../src/lib/ai/prompts/impact-analysis.prompt';
import { CONFLICT_PREDICTION_SYSTEM } from '../../src/lib/ai/prompts/conflict-prediction.prompt';
import { COMPLETION_VERIFY_SYSTEM } from '../../src/lib/ai/prompts/completion-verify.prompt';
import { CHAT_SYSTEM } from '../../src/lib/ai/prompts/chat.prompt';

describe('R-124 getMockAiResponse: dispatches by system prompt', () => {
  it('plan-diff prompt returns a parseable PlanDiffResult shape', () => {
    const raw = getMockAiResponse(PLAN_DIFF_SYSTEM);
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed.changes)).toBe(true);
    expect(parsed.changes.length).toBeGreaterThan(0);
    expect(typeof parsed.summary).toBe('string');
    expect(typeof parsed.breakingChanges).toBe('boolean');
  });

  it('impact-analysis prompt returns a valid ImpactResult shape', () => {
    const raw = getMockAiResponse(IMPACT_ANALYSIS_SYSTEM);
    const parsed = JSON.parse(raw);
    expect(typeof parsed.compatibilityScore).toBe('number');
    expect(['no_impact', 'rebind', 'cancel']).toContain(parsed.suggestedAction);
    expect(Array.isArray(parsed.affectedAreas)).toBe(true);
  });

  it('conflict-prediction prompt returns conflicts array', () => {
    const raw = getMockAiResponse(CONFLICT_PREDICTION_SYSTEM);
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed.conflicts)).toBe(true);
  });

  it('completion-verify prompt returns verification verdict with score', () => {
    const raw = getMockAiResponse(COMPLETION_VERIFY_SYSTEM);
    const parsed = JSON.parse(raw);
    expect(typeof parsed.verified).toBe('boolean');
    expect(typeof parsed.score).toBe('number');
    expect(parsed.breakdown).toBeDefined();
  });

  it('chat prompt returns a non-empty string (not necessarily JSON)', () => {
    const raw = getMockAiResponse(CHAT_SYSTEM);
    expect(typeof raw).toBe('string');
    expect(raw.length).toBeGreaterThan(0);
  });

  it('unknown system prompt returns an empty-object JSON payload', () => {
    const raw = getMockAiResponse('You are an unrelated assistant.');
    expect(JSON.parse(raw)).toEqual({});
  });
});

describe('R-124 AiClient with PLANSYNC_AI_MOCK=1: end-to-end short-circuit', () => {
  const ORIGINAL_LLM_API_KEY = process.env.LLM_API_KEY;
  const ORIGINAL_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const ORIGINAL_AI_MOCK = process.env.PLANSYNC_AI_MOCK;

  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as { aiClient?: unknown }).aiClient;
    delete process.env.LLM_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.PLANSYNC_AI_MOCK = '1';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { aiClient?: unknown }).aiClient;
    if (ORIGINAL_LLM_API_KEY === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = ORIGINAL_LLM_API_KEY;
    if (ORIGINAL_ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_API_KEY;
    if (ORIGINAL_AI_MOCK === undefined) delete process.env.PLANSYNC_AI_MOCK;
    else process.env.PLANSYNC_AI_MOCK = ORIGINAL_AI_MOCK;
  });

  it('reports the mock provider as available', async () => {
    const { aiClient } = await import('../../src/lib/ai/client');
    expect(aiClient.isAvailable).toBe(true);
    expect(aiClient.providerName).toBe('mock');
  });

  it('returns canned plan-diff JSON without performing any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { aiClient } = await import('../../src/lib/ai/client');

    const result = await aiClient.complete(PLAN_DIFF_SYSTEM, 'user msg');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(Array.isArray(parsed.changes)).toBe(true);
    expect(typeof parsed.summary).toBe('string');
  });

  it('mock takes precedence over real provider keys for hermetic CI runs', async () => {
    process.env.ANTHROPIC_API_KEY = 'real-key-that-must-not-be-used';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { aiClient } = await import('../../src/lib/ai/client');

    expect(aiClient.providerName).toBe('mock');
    const result = await aiClient.complete(IMPACT_ANALYSIS_SYSTEM, 'user');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(JSON.parse(result!).compatibilityScore).toEqual(expect.any(Number));
  });
});

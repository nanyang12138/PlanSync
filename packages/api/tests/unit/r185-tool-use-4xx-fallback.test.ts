// Regression tests for review-finding issues #819 / #823 / #828 on PR #818.
//
// These exercise the REAL aiClient with a fetch spy — DO NOT mock
// ../../src/lib/ai/client here. The consistency-helper regressions
// for #829/#830 live in a sibling file because they have to mock the
// client and vi.mock is module-wide hoisted.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'LLM_API_KEY',
  'LLM_API_BASE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'PLANSYNC_AI_MOCK',
] as const;
const originals: Record<string, string | undefined> = {};

const recordAiCallMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/lib/ai/usage', () => ({
  recordAiCall: recordAiCallMock,
}));

function snapshotEnv() {
  for (const k of ENV_KEYS) originals[k] = process.env[k];
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (originals[k] === undefined) delete process.env[k];
    else process.env[k] = originals[k];
  }
}

function http(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function text(textBody: string): Response {
  return http(200, {
    content: [{ type: 'text', text: textBody }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

describe('Issues #819 / #823 / #828: tool_use 4xx falls back to text mode', () => {
  beforeEach(() => {
    snapshotEnv();
    vi.resetModules();
    delete (globalThis as { aiClient?: unknown }).aiClient;
    for (const k of ENV_KEYS) delete process.env[k];
    recordAiCallMock.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { aiClient?: unknown }).aiClient;
    restoreEnv();
  });

  it('retries the same provider without tools on 4xx and uses text-mode result on success', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(http(400, { error: 'tools not supported on this model' }))
      .mockResolvedValueOnce(text('{"compat":true}'));

    const { aiClient } = await import('../../src/lib/ai/client');
    const out = await aiClient.complete('SYS', 'USER', {
      purpose: 'unit-fallback-4xx',
      tool: { name: 'emit_x', description: '', jsonSchema: { type: 'object' } },
    });

    expect(out).toBe('{"compat":true}');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    const secondBody = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
    expect(firstBody.tools).toBeDefined();
    expect(firstBody.tool_choice).toBeDefined();
    expect(secondBody.tools).toBeUndefined();
    expect(secondBody.tool_choice).toBeUndefined();

    const errorCodes = recordAiCallMock.mock.calls.map((c) => c[0].errorCode);
    expect(errorCodes).toContain('http_400');
    expect(errorCodes).toContain('tool_use_rejected_text_fallback_ok');
  });

  it('does NOT trigger the text retry on 429 (rate-limit is a different signal)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(http(429, { error: 'rate limited' }));

    const { aiClient } = await import('../../src/lib/ai/client');
    const out = await aiClient.complete('SYS', 'USER', {
      purpose: 'unit-fallback-429',
      tool: { name: 'emit_x', description: '', jsonSchema: { type: 'object' } },
    });
    expect(out).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT trigger the text retry when no tool was requested', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(http(400, { error: 'bad' }));

    const { aiClient } = await import('../../src/lib/ai/client');
    const out = await aiClient.complete('SYS', 'USER', {
      purpose: 'unit-fallback-no-tool',
    });
    expect(out).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('text retry that also fails leaves the chain free to fall through to null', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(http(400, { error: 'tools not supported' }))
      .mockResolvedValueOnce(http(400, { error: 'still bad' }));

    const { aiClient } = await import('../../src/lib/ai/client');
    const out = await aiClient.complete('SYS', 'USER', {
      purpose: 'unit-fallback-both-fail',
      tool: { name: 'emit_x', description: '', jsonSchema: { type: 'object' } },
    });
    expect(out).toBeNull();
  });

  it('records text-fallback as its own ai_calls row (observability)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(http(400, { error: 'tools rejected' }))
      .mockResolvedValueOnce(text('{"ok":true}'));

    const { aiClient } = await import('../../src/lib/ai/client');
    await aiClient.complete('SYS', 'USER', {
      purpose: 'unit-fallback-observability',
      tool: { name: 'emit_x', description: '', jsonSchema: { type: 'object' } },
    });

    expect(recordAiCallMock).toHaveBeenCalledTimes(2);
    const rows = recordAiCallMock.mock.calls.map((c) => c[0]);
    expect(rows[0].errorCode).toBe('http_400');
    expect(rows[1].errorCode).toBe('tool_use_rejected_text_fallback_ok');
    expect(rows[1].ok).toBe(true);
  });
});

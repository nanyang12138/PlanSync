import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickFirstContentText } from '../../src/lib/ai/client';

describe('pickFirstContentText (#138)', () => {
  it('returns null for non-object inputs', () => {
    expect(pickFirstContentText(null)).toBeNull();
    expect(pickFirstContentText(undefined)).toBeNull();
    expect(pickFirstContentText('string')).toBeNull();
    expect(pickFirstContentText(42)).toBeNull();
    expect(pickFirstContentText(true)).toBeNull();
  });

  it('returns null when content is missing or not an array', () => {
    expect(pickFirstContentText({})).toBeNull();
    expect(pickFirstContentText({ content: null })).toBeNull();
    expect(pickFirstContentText({ content: 'not-an-array' })).toBeNull();
    expect(pickFirstContentText({ content: { text: 'oops' } })).toBeNull();
  });

  it('returns null when content array is empty', () => {
    expect(pickFirstContentText({ content: [] })).toBeNull();
  });

  it('returns null when first item is not an object', () => {
    expect(pickFirstContentText({ content: [null] })).toBeNull();
    expect(pickFirstContentText({ content: ['plain string'] })).toBeNull();
    expect(pickFirstContentText({ content: [42] })).toBeNull();
  });

  it('returns null when first item has missing or non-string text', () => {
    expect(pickFirstContentText({ content: [{}] })).toBeNull();
    expect(pickFirstContentText({ content: [{ text: null }] })).toBeNull();
    expect(pickFirstContentText({ content: [{ text: 42 }] })).toBeNull();
    expect(pickFirstContentText({ content: [{ text: '' }] })).toBeNull();
  });

  it('returns the first content[0].text when it is a non-empty string', () => {
    expect(pickFirstContentText({ content: [{ text: 'hello' }] })).toBe('hello');
    // Subsequent items must be ignored — Anthropic returns one text block per
    // assistant message in our prompts; validate the picker stays at index 0.
    expect(
      pickFirstContentText({
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      }),
    ).toBe('first');
  });
});

describe('AiClient.complete() error/timeout handling (#138)', () => {
  const ORIGINAL_LLM_API_KEY = process.env.LLM_API_KEY;
  const ORIGINAL_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  // R-124: setup.ts sets PLANSYNC_AI_MOCK=1 by default. These tests exercise
  // the real-provider code paths so we must turn the mock off per-test and
  // restore it afterwards.
  const ORIGINAL_AI_MOCK = process.env.PLANSYNC_AI_MOCK;

  // Each test re-imports the module so the singleton sees the env we want.
  // The module caches the client on `globalThis.aiClient`, so resetting
  // modules alone is not enough — we must clear the global too.
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    delete (globalThis as { aiClient?: unknown }).aiClient;
    delete process.env.LLM_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PLANSYNC_AI_MOCK;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as { aiClient?: unknown }).aiClient;
    if (ORIGINAL_LLM_API_KEY === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = ORIGINAL_LLM_API_KEY;
    if (ORIGINAL_ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_API_KEY;
    if (ORIGINAL_AI_MOCK === undefined) delete process.env.PLANSYNC_AI_MOCK;
    else process.env.PLANSYNC_AI_MOCK = ORIGINAL_AI_MOCK;
  });

  it('returns null when no provider is configured (no AI keys set)', async () => {
    const { aiClient } = await import('../../src/lib/ai/client');
    expect(aiClient.isAvailable).toBe(false);
    expect(aiClient.providerName).toBe('none');
    const result = await aiClient.complete('sys', 'user');
    expect(result).toBeNull();
  });

  it('retries and ultimately returns null on persistent non-Error throw (unknown narrowing path)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const { aiClient } = await import('../../src/lib/ai/client');
    expect(aiClient.isAvailable).toBe(true);

    // Throw a non-Error value to exercise the `err instanceof Error ? ... : String(err)`
    // branch that #138 calls out as untested.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      .mockImplementation(async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'plain-string-rejection';
      });

    const promise = aiClient.complete('sys', 'user');
    // Drain the retry backoff (1s, 2s) without waiting real time.
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toBeNull();
    // Initial call + 2 retries = 3 attempts.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('returns null on non-OK HTTP response (errText path)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const { aiClient } = await import('../../src/lib/ai/client');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('rate limited', { status: 429 }),
    );

    const promise = aiClient.complete('sys', 'user');
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('returns null when response.json() yields a shape pickFirstContentText cannot read', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const { aiClient } = await import('../../src/lib/ai/client');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const promise = aiClient.complete('sys', 'user');
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toBeNull();
  });

  it('returns extractJson(text) on a valid response', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const { aiClient } = await import('../../src/lib/ai/client');

    const validResponse = {
      content: [{ type: 'text', text: '```json\n{"answer":42}\n```' }],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(validResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await aiClient.complete('sys', 'user');
    expect(result).toBe('{"answer":42}');
  });
});

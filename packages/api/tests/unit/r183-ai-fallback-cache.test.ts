// R-183: AI provider fallback + 5min cache + per-purpose token bucket.
//
// All tests in this file isolate via `vi.resetModules()` + clearing the
// `globalThis.aiClient` singleton + clearing the relevant env vars so
// each scenario sees a fresh AiClient instance with the configuration
// it cares about. `recordAiCall` is mocked so we never touch Postgres
// from a unit test — the real persistence layer is covered by the R-182
// integration test in `ai.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'LLM_API_KEY',
  'LLM_API_BASE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'PLANSYNC_AI_MOCK',
  'PLANSYNC_AI_RATE_LIMIT_CAPACITY',
  'PLANSYNC_AI_RATE_LIMIT_REFILL_PER_SEC',
  'PLANSYNC_AI_CACHE_TTL_MS',
  'PLANSYNC_AI_CACHE_MAX_ENTRIES',
] as const;

const originals: Record<string, string | undefined> = {};

// Hoisted mock so vi.mock() registration runs before the SUT import.
const recordAiCallMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/lib/ai/usage', () => ({
  recordAiCall: recordAiCallMock,
}));

function makeOkAnthropicResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
      usage: { input_tokens: 12, output_tokens: 34 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function snapshotEnv() {
  for (const k of ENV_KEYS) originals[k] = process.env[k];
}

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (originals[k] === undefined) delete process.env[k];
    else process.env[k] = originals[k];
  }
}

describe('R-183 AI client provider fallback + cache + rate limit', () => {
  beforeEach(() => {
    snapshotEnv();
    vi.resetModules();
    delete (globalThis as { aiClient?: unknown }).aiClient;
    // Force the AI tests to exercise the real provider chain instead of
    // the deterministic mock provider that setup.ts enables by default.
    for (const k of ENV_KEYS) delete process.env[k];
    recordAiCallMock.mockReset();
    recordAiCallMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { aiClient?: unknown }).aiClient;
    restoreEnv();
  });

  describe('TokenBucket', () => {
    it('allows up to capacity consumes before refusing', async () => {
      const { TokenBucket } = await import('../../src/lib/ai/client');
      const bucket = new TokenBucket(3, 0.0001); // tiny refill so we don't get bonus tokens
      const t0 = 1_000_000;
      expect(bucket.tryConsume('p', t0)).toBe(true);
      expect(bucket.tryConsume('p', t0)).toBe(true);
      expect(bucket.tryConsume('p', t0)).toBe(true);
      expect(bucket.tryConsume('p', t0)).toBe(false);
    });

    it('refills tokens linearly with elapsed time', async () => {
      const { TokenBucket } = await import('../../src/lib/ai/client');
      const bucket = new TokenBucket(2, 1); // 1 token / sec
      const t0 = 2_000_000;
      bucket.tryConsume('p', t0);
      bucket.tryConsume('p', t0);
      expect(bucket.tryConsume('p', t0)).toBe(false);
      // 1.5s later → 1 full token available, still under capacity
      expect(bucket.tryConsume('p', t0 + 1500)).toBe(true);
      // immediately try again → empty
      expect(bucket.tryConsume('p', t0 + 1500)).toBe(false);
    });

    it('isolates buckets per key', async () => {
      const { TokenBucket } = await import('../../src/lib/ai/client');
      const bucket = new TokenBucket(1, 0.0001);
      const t0 = 3_000_000;
      expect(bucket.tryConsume('a', t0)).toBe(true);
      expect(bucket.tryConsume('a', t0)).toBe(false);
      expect(bucket.tryConsume('b', t0)).toBe(true);
    });

    it('is disabled when capacity<=0', async () => {
      const { TokenBucket } = await import('../../src/lib/ai/client');
      const bucket = new TokenBucket(0, 1);
      for (let i = 0; i < 100; i++) expect(bucket.tryConsume('p')).toBe(true);
    });
  });

  describe('ResponseCache', () => {
    it('returns null before set; returns entry within TTL; expires past TTL', async () => {
      const { ResponseCache } = await import('../../src/lib/ai/client');
      const cache = new ResponseCache(60_000, 10);
      const t0 = 4_000_000;
      const key = cache.key('drift_impact', 'hash-xyz');
      expect(cache.get(key, t0)).toBeNull();
      cache.set(
        key,
        {
          value: 'hello',
          provider: 'amd',
          model: 'm',
          outputHash: 'oh',
          inputTokens: 1,
          outputTokens: 2,
        },
        t0,
      );
      expect(cache.get(key, t0 + 1000)?.value).toBe('hello');
      expect(cache.get(key, t0 + 60_001)).toBeNull();
    });

    it('FIFO-evicts when maxEntries is reached', async () => {
      const { ResponseCache } = await import('../../src/lib/ai/client');
      const cache = new ResponseCache(60_000, 2);
      const t0 = 5_000_000;
      const baseEntry = {
        provider: 'amd',
        model: 'm',
        outputHash: null,
        inputTokens: null,
        outputTokens: null,
      };
      cache.set('k1', { ...baseEntry, value: 'v1' }, t0);
      cache.set('k2', { ...baseEntry, value: 'v2' }, t0);
      cache.set('k3', { ...baseEntry, value: 'v3' }, t0);
      // k1 should have been evicted (oldest insert)
      expect(cache.get('k1', t0)).toBeNull();
      expect(cache.get('k2', t0)?.value).toBe('v2');
      expect(cache.get('k3', t0)?.value).toBe('v3');
    });
  });

  describe('provider fallback chain', () => {
    it('falls back from AMD 429 to Anthropic on the next provider in the chain', async () => {
      process.env.LLM_API_KEY = 'amd-key';
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      // Disable rate limit so it doesn't get in the way
      process.env.PLANSYNC_AI_RATE_LIMIT_CAPACITY = '0';

      const { aiClient } = await import('../../src/lib/ai/client');
      expect(aiClient.isAvailable).toBe(true);
      expect(aiClient.providerName).toBe('amd');

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (
        input: RequestInfo | URL,
      ) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('amd.com')) {
          return new Response('rate limited', { status: 429 });
        }
        if (url.includes('api.anthropic.com')) {
          return makeOkAnthropicResponse('fallback-text');
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch);

      const result = await aiClient.complete('sys', 'user', { purpose: 'drift_impact' });

      expect(result).toBe('fallback-text');
      // AMD attempt + Anthropic attempt = 2 fetches; no retries on AMD
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const providersRecorded = recordAiCallMock.mock.calls.map(
        (c) => (c[0] as { provider: string }).provider,
      );
      expect(providersRecorded).toContain('amd');
      expect(providersRecorded).toContain('anthropic');

      const amdRow = recordAiCallMock.mock.calls.find(
        (c) => (c[0] as { provider: string }).provider === 'amd',
      )?.[0] as { ok: boolean; errorCode: string | null } | undefined;
      expect(amdRow?.ok).toBe(false);
      expect(amdRow?.errorCode).toBe('rate_limited');

      const anthropicRow = recordAiCallMock.mock.calls.find(
        (c) => (c[0] as { provider: string }).provider === 'anthropic',
      )?.[0] as { ok: boolean; cacheHit: boolean } | undefined;
      expect(anthropicRow?.ok).toBe(true);
      expect(anthropicRow?.cacheHit).toBe(false);
    });

    it('returns null and records last error when every provider fails', async () => {
      process.env.LLM_API_KEY = 'amd-key';
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.PLANSYNC_AI_RATE_LIMIT_CAPACITY = '0';

      const { aiClient } = await import('../../src/lib/ai/client');
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('boom', { status: 429 }));

      const result = await aiClient.complete('sys', 'user', { purpose: 'p' });
      expect(result).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('response cache', () => {
    it('cache hit on identical (purpose, inputHash) — no second fetch', async () => {
      process.env.ANTHROPIC_API_KEY = 'k';
      process.env.PLANSYNC_AI_RATE_LIMIT_CAPACITY = '0';

      const { aiClient } = await import('../../src/lib/ai/client');
      aiClient.resetForTests();

      // mockImplementation (not mockResolvedValue) so each fetch gets a
      // FRESH Response — Response body streams can only be read once.
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => makeOkAnthropicResponse('answer-A'));

      const first = await aiClient.complete('sys', 'user', { purpose: 'verify' });
      const second = await aiClient.complete('sys', 'user', { purpose: 'verify' });

      expect(first).toBe('answer-A');
      expect(second).toBe('answer-A');
      // Only the first call hits the network
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const cacheHitCount = recordAiCallMock.mock.calls.filter(
        (c) => (c[0] as { cacheHit: boolean }).cacheHit === true,
      ).length;
      expect(cacheHitCount).toBe(1);
    });

    it('different purposes share no cache namespace', async () => {
      process.env.ANTHROPIC_API_KEY = 'k';
      process.env.PLANSYNC_AI_RATE_LIMIT_CAPACITY = '0';

      const { aiClient } = await import('../../src/lib/ai/client');
      aiClient.resetForTests();

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => makeOkAnthropicResponse('text'));

      await aiClient.complete('sys', 'user', { purpose: 'verify' });
      await aiClient.complete('sys', 'user', { purpose: 'drift_impact' });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('TTL=0 disables the cache', async () => {
      process.env.ANTHROPIC_API_KEY = 'k';
      process.env.PLANSYNC_AI_RATE_LIMIT_CAPACITY = '0';
      process.env.PLANSYNC_AI_CACHE_TTL_MS = '0';

      const { aiClient } = await import('../../src/lib/ai/client');
      aiClient.resetForTests();

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => makeOkAnthropicResponse('a'));

      await aiClient.complete('sys', 'user', { purpose: 'verify' });
      await aiClient.complete('sys', 'user', { purpose: 'verify' });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('per-purpose token bucket', () => {
    it('rate-limits calls past capacity and records errorCode=rate_limited', async () => {
      process.env.ANTHROPIC_API_KEY = 'k';
      process.env.PLANSYNC_AI_RATE_LIMIT_CAPACITY = '2';
      process.env.PLANSYNC_AI_RATE_LIMIT_REFILL_PER_SEC = '0.0001';
      // Cache off so each call goes through the limiter
      process.env.PLANSYNC_AI_CACHE_TTL_MS = '0';

      const { aiClient } = await import('../../src/lib/ai/client');
      aiClient.resetForTests();

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => makeOkAnthropicResponse('ok'));

      // 2 calls within capacity → both succeed
      const r1 = await aiClient.complete('s', 'u1', { purpose: 'verify' });
      const r2 = await aiClient.complete('s', 'u2', { purpose: 'verify' });
      expect(r1).toBe('ok');
      expect(r2).toBe('ok');
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // 3rd call → rate limited, NO additional fetch
      const r3 = await aiClient.complete('s', 'u3', { purpose: 'verify' });
      expect(r3).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const lastRecord = recordAiCallMock.mock.calls.at(-1)?.[0] as {
        errorCode: string | null;
        ok: boolean;
        cacheHit: boolean;
      };
      expect(lastRecord.errorCode).toBe('rate_limited');
      expect(lastRecord.ok).toBe(false);
      expect(lastRecord.cacheHit).toBe(false);
    });

    it('different purposes have independent buckets', async () => {
      process.env.ANTHROPIC_API_KEY = 'k';
      process.env.PLANSYNC_AI_RATE_LIMIT_CAPACITY = '1';
      process.env.PLANSYNC_AI_RATE_LIMIT_REFILL_PER_SEC = '0.0001';
      process.env.PLANSYNC_AI_CACHE_TTL_MS = '0';

      const { aiClient } = await import('../../src/lib/ai/client');
      aiClient.resetForTests();

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => makeOkAnthropicResponse('ok'));

      const r1 = await aiClient.complete('s', 'u', { purpose: 'verify' });
      const r2 = await aiClient.complete('s', 'u', { purpose: 'drift_impact' });
      // Both should succeed because they use distinct buckets
      expect(r1).toBe('ok');
      expect(r2).toBe('ok');
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Second call on the same purpose hits its own empty bucket
      const r3 = await aiClient.complete('s', 'u2', { purpose: 'verify' });
      expect(r3).toBeNull();
    });
  });
});

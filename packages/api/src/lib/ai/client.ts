import { createHash } from 'crypto';
import { logger } from '../logger';
import { getMockAiResponse } from './mock-responses';
import { recordAiCall, type AiCallRecord } from './usage';

function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:\w*)\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) return fenceMatch[1].trim();

  const braceMatch = text.match(/(\{[\s\S]*\})/);
  if (braceMatch) return braceMatch[1].trim();

  return text.trim();
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

type Provider = 'amd' | 'anthropic' | 'mock';

// R-185: when `tool` is set on a complete() call the provider switches from
// free-text generation to tool_use strict mode. The model is forced to call
// the named tool exactly once and its `input` must conform to `jsonSchema`
// at the token-decoding layer. parseResponse then extracts that input as a
// JSON string so the rest of the pipeline (cache, ai_calls record, callers)
// keeps treating the result as "a JSON string the caller will parse".
export interface ToolDescriptor {
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
}

interface ProviderConfig {
  name: Provider;
  apiKey: string;
  buildUrl: (model: string) => string;
  buildHeaders: (apiKey: string) => Record<string, string>;
  buildBody: (model: string, system: string, user: string, tool?: ToolDescriptor) => object;
  parseResponse: (data: unknown) => string | null;
}

interface ConfiguredProvider {
  config: ProviderConfig;
  model: string;
}

// R-182: callers pass a `purpose` so /api/ai-usage can group by call site.
// `promptVersion` is opaque and defaults to 'v1' until prompts start
// versioning themselves.
//
// R-185: callers can also pass a `tool` to switch on strict structured output
// (Anthropic tool_use forced-call). The mock provider ignores `tool` and
// keeps returning canned JSON via getMockAiResponse().
export interface AiCompleteOptions {
  purpose: string;
  promptVersion?: string;
  tool?: ToolDescriptor;
}

export function pickFirstContentText(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0];
  if (typeof first !== 'object' || first === null) return null;
  const text = (first as { text?: unknown }).text;
  return typeof text === 'string' && text.length > 0 ? text : null;
}

// R-185: extract the `input` payload from the first `tool_use` block in an
// Anthropic-style response and return it serialized as JSON. This is the
// canonical happy path when `tool_choice: { type: 'tool' }` is set — the
// model is constrained to emit exactly one tool_use block whose input
// already satisfies our jsonSchema, so the caller can JSON.parse it without
// the brittle markdown-fence / regex extraction the text path needs.
//
// Returns null when the response has no tool_use block (e.g. the provider
// is misconfigured or returned a refusal); the caller falls back to the
// text path automatically so we don't break AMD installs that don't yet
// support tool_use.
export function pickFirstToolUseInput(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return null;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const type = (block as { type?: unknown }).type;
    if (type !== 'tool_use') continue;
    const input = (block as { input?: unknown }).input;
    if (input === undefined) continue;
    try {
      return JSON.stringify(input);
    } catch {
      return null;
    }
  }
  return null;
}

// AMD internal LLM uses the same Anthropic messages API format,
// just with a different base URL and Ocp-Apim-Subscription-Key header.
// LLM_API_BASE should point to the Anthropic-compatible endpoint,
// e.g. https://llm-api.amd.com/Anthropic
const AMD_BASE = (process.env.LLM_API_BASE || 'https://llm-api.amd.com/Anthropic').replace(
  /\/$/,
  '',
);

// R-185: buildBody factory shared by AMD + Anthropic providers. When `tool`
// is set we attach Anthropic's `tools` array + `tool_choice` so the decoder
// is constrained to emit a single tool_use block. AMD's Anthropic-compatible
// endpoint accepts the same shape; if a deployment doesn't, the response
// will lack a tool_use block and pickFirstToolUseInput returns null, which
// triggers the text-path fallback in complete().
function buildAnthropicBody(
  model: string,
  system: string,
  user: string,
  tool?: ToolDescriptor,
): object {
  const base: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: user }],
  };
  if (tool) {
    base.tools = [
      {
        name: tool.name,
        description: tool.description,
        input_schema: tool.jsonSchema,
      },
    ];
    base.tool_choice = { type: 'tool', name: tool.name };
  }
  return base;
}

// R-185: when a tool was requested, prefer the tool_use payload; fall back
// to the text content (and the existing extractJson) only when tool_use is
// absent — that way an AMD installation without strict tool support still
// produces a usable result via the legacy path.
function buildParseResponse(): (data: unknown) => string | null {
  return (data) => pickFirstToolUseInput(data) ?? pickFirstContentText(data);
}

const AMD_PROVIDER: Omit<ProviderConfig, 'apiKey'> = {
  name: 'amd',
  buildUrl: () => `${AMD_BASE}/v1/messages`,
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    'x-api-key': 'dummy',
    'anthropic-version': '2023-06-01',
    'Ocp-Apim-Subscription-Key': apiKey,
  }),
  buildBody: buildAnthropicBody,
  parseResponse: buildParseResponse(),
};

function parseCustomHeaders(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of (raw || '').split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

const ANTHROPIC_BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(
  /\/$/,
  '',
);
const ANTHROPIC_CUSTOM_HEADERS = parseCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS || '');

// R-124: deterministic mock provider used when PLANSYNC_AI_MOCK=1.
// buildUrl/buildHeaders/buildBody are never invoked because complete()
// short-circuits before any network call when name === 'mock'. They are kept
// as no-op stubs so the ProviderConfig shape stays uniform.
const MOCK_PROVIDER: Omit<ProviderConfig, 'apiKey'> = {
  name: 'mock',
  buildUrl: () => 'mock://ai',
  buildHeaders: () => ({}),
  // R-185: mock provider does not implement tool_use; the `tool` arg is
  // ignored. complete() short-circuits before buildBody runs anyway, so
  // this is purely about keeping the ProviderConfig shape uniform.
  buildBody: (model, system, user) => ({ model, system, user }),
  parseResponse: pickFirstContentText,
};

const ANTHROPIC_PROVIDER: Omit<ProviderConfig, 'apiKey'> = {
  name: 'anthropic',
  buildUrl: () => `${ANTHROPIC_BASE}/v1/messages`,
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    ...ANTHROPIC_CUSTOM_HEADERS,
  }),
  buildBody: buildAnthropicBody,
  parseResponse: buildParseResponse(),
};

// R-182: parse `{ usage: { input_tokens, output_tokens } }` (Anthropic
// shape) when present so token counts make it into ai_calls. The mock
// provider never returns this block, so the columns stay null.
function pickTokenUsage(data: unknown): { input?: number; output?: number } {
  if (typeof data !== 'object' || data === null) return {};
  const usage = (data as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return {};
  const inputRaw = (usage as { input_tokens?: unknown }).input_tokens;
  const outputRaw = (usage as { output_tokens?: unknown }).output_tokens;
  return {
    input: typeof inputRaw === 'number' ? inputRaw : undefined,
    output: typeof outputRaw === 'number' ? outputRaw : undefined,
  };
}

// R-182: backwards-compatible signature — older call sites pass two
// strings only. New code should pass `{ purpose }` so /api/ai-usage can
// segment metrics. The default 'unspecified' surfaces stragglers in
// dashboards rather than silently dropping them on the floor.
type CompleteArg = AiCompleteOptions | string | undefined;

function resolveOptions(arg: CompleteArg): AiCompleteOptions {
  if (typeof arg === 'string') return { purpose: arg };
  if (arg && typeof arg === 'object') return arg;
  return { purpose: 'unspecified' };
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// R-183: token-bucket per `purpose`. The bucket keeps a runaway caller
// (eg. a misbehaving drift-enrich loop) from burning the entire AMD
// quota. Defaults are deliberately generous so test/dev workloads never
// notice the throttle; tune via PLANSYNC_AI_RATE_LIMIT_* env vars.
//
// `capacity <= 0` disables the limiter entirely (tryConsume always
// returns true) so existing tests that fire many calls per second do not
// regress.
export interface TokenBucketState {
  tokens: number;
  lastRefillMs: number;
}

export class TokenBucket {
  private buckets = new Map<string, TokenBucketState>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {}

  tryConsume(key: string, now: number = Date.now()): boolean {
    if (this.capacity <= 0 || this.refillPerSec <= 0) return true;
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, lastRefillMs: now };
      this.buckets.set(key, b);
    } else {
      const elapsedSec = Math.max(0, (now - b.lastRefillMs) / 1000);
      if (elapsedSec > 0) {
        b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
        b.lastRefillMs = now;
      }
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  reset(): void {
    this.buckets.clear();
  }
}

// R-183: per (purpose, inputHash) result cache, TTL 5min. Only successful
// responses are stored. Cache hits short-circuit before the rate limiter
// AND the provider call, but still write an ai_calls row with
// `cacheHit=true` so /api/ai-usage shows the saved round-trips.
//
// Simple FIFO eviction keeps the implementation dependency-free; a
// runaway caller can fill the cache with unique hashes but they expire
// within 5 minutes regardless.
interface CacheEntry {
  value: string;
  provider: string;
  model: string;
  outputHash: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  expiresAt: number;
}

export class ResponseCache {
  private entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  key(purpose: string, inputHash: string): string {
    return `${purpose}:${inputHash}`;
  }

  get(key: string, now: number = Date.now()): CacheEntry | null {
    if (this.ttlMs <= 0) return null;
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return e;
  }

  set(key: string, entry: Omit<CacheEntry, 'expiresAt'>, now: number = Date.now()): void {
    if (this.ttlMs <= 0 || this.maxEntries <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey !== undefined) this.entries.delete(firstKey);
    }
    this.entries.set(key, { ...entry, expiresAt: now + this.ttlMs });
  }

  reset(): void {
    this.entries.clear();
  }
}

// Per-provider call result. `value=null` with `ok=true` means the
// provider replied but the response was empty/unparseable — this is a
// content failure, not a transport failure, so we do NOT fall back to
// the next provider.
interface ProviderCallResult {
  ok: boolean;
  value: string | null;
  outputHash: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  errorCode: string | null;
}

class AiClient {
  private providers: ConfiguredProvider[] = [];
  private model: string;
  private maxRetries = 2;
  private timeout = 60000;
  private readonly cache: ResponseCache;
  private readonly rateLimiter: TokenBucket;

  constructor() {
    this.cache = new ResponseCache(
      envNumber('PLANSYNC_AI_CACHE_TTL_MS', 5 * 60 * 1000),
      envNumber('PLANSYNC_AI_CACHE_MAX_ENTRIES', 500),
    );
    this.rateLimiter = new TokenBucket(
      envNumber('PLANSYNC_AI_RATE_LIMIT_CAPACITY', 60),
      envNumber('PLANSYNC_AI_RATE_LIMIT_REFILL_PER_SEC', 1),
    );

    // R-124: PLANSYNC_AI_MOCK=1 forces a deterministic mock provider so CI
    // can exercise AI code paths without real API keys. Mock takes precedence
    // over any real key so tests stay hermetic even when keys are present.
    const mockEnabled = process.env.PLANSYNC_AI_MOCK === '1';
    const amdKey = process.env.LLM_API_KEY?.trim() || '';
    const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() || '';

    if (mockEnabled) {
      const mockModel = process.env.PLANSYNC_AI_MOCK_MODEL || 'mock-model';
      this.providers.push({
        config: { ...MOCK_PROVIDER, apiKey: 'mock' },
        model: mockModel,
      });
      this.model = mockModel;
      logger.info({ provider: 'mock', model: mockModel }, 'AI client using mock provider');
      return;
    }

    // R-183: build an ordered provider chain. AMD is preferred (cheaper,
    // internal); Anthropic acts as a fallback when AMD returns an error
    // or hits rate-limit. Either key alone yields a single-entry chain
    // — semantically identical to the pre-R-183 behaviour.
    if (amdKey) {
      const amdModel = process.env.LLM_MODEL_NAME || 'Claude-Sonnet-4.5';
      this.providers.push({
        config: { ...AMD_PROVIDER, apiKey: amdKey },
        model: amdModel,
      });
    }
    if (anthropicKey) {
      const anthropicModel =
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-20250514';
      this.providers.push({
        config: { ...ANTHROPIC_PROVIDER, apiKey: anthropicKey },
        model: anthropicModel,
      });
    }

    if (this.providers.length === 0) {
      this.model = '';
      logger.debug('No LLM_API_KEY or ANTHROPIC_API_KEY configured, AI features disabled');
      return;
    }

    this.model = this.providers[0].model;
    logger.info(
      {
        chain: this.providers.map((p) => p.config.name),
        primaryModel: this.model,
      },
      'AI client provider chain configured',
    );
  }

  get isAvailable(): boolean {
    return this.providers.length > 0;
  }

  get providerName(): string {
    return this.providers[0]?.config.name ?? 'none';
  }

  // R-143: completion-verify writes the model name onto each run for audit.
  // Returns null when no provider is configured so callers can distinguish
  // "AI unavailable" from "AI returned no result".
  get modelName(): string | null {
    return this.providers.length > 0 ? this.model : null;
  }

  // Test seam — production code should not touch internal state. Resets
  // the cache + token buckets so per-test isolation is trivial.
  resetForTests(): void {
    this.cache.reset();
    this.rateLimiter.reset();
  }

  // R-182: third argument accepts either an options bag (`{ purpose }`) or
  // a bare purpose string for ergonomic call sites.
  //
  // R-183 control flow:
  //   1. cache check (no rate-limit cost, no provider call)
  //   2. token-bucket consume for `purpose`
  //   3. provider chain — on transport failure / rate limit, fall back
  //      to the next provider; on content-empty response, stop
  //   4. populate cache on success
  async complete(system: string, user: string, opts?: CompleteArg): Promise<string | null> {
    const { purpose, promptVersion: rawPromptVersion, tool } = resolveOptions(opts);
    // R-185: when the caller requests strict tool_use, tag the recorded
    // promptVersion with `-toolv1` so the R-182 dashboard can split metrics
    // by tool-mode vs legacy-text-mode without changing the schema.
    const promptVersion =
      tool && rawPromptVersion === undefined
        ? 'v1-toolv1'
        : tool && rawPromptVersion !== undefined
          ? `${rawPromptVersion}-toolv1`
          : (rawPromptVersion ?? 'v1');
    // R-185: include the tool's jsonSchema in the inputHash so the cache
    // doesn't return a text-mode cached answer to a tool-mode caller (or
    // vice versa), and so a schema change invalidates the cache.
    const toolHashSegment = tool ? `\n---tool:${tool.name}:${JSON.stringify(tool.jsonSchema)}` : '';
    const inputHash = sha256(`${system}\n---\n${user}${toolHashSegment}`);
    const promptHash = sha256(system);
    const cacheKey = this.cache.key(purpose, inputHash);

    if (this.providers.length === 0) {
      logger.debug('No AI provider configured, skipping AI call');
      await this.recordSafe({
        purpose,
        provider: 'none',
        model: 'none',
        promptHash,
        inputHash,
        outputHash: null,
        promptVersion,
        latencyMs: 0,
        inputTokens: null,
        outputTokens: null,
        ok: false,
        errorCode: 'unavailable',
        cacheHit: false,
      });
      return null;
    }

    // R-183 step 1: cache lookup. Hit → emit cacheHit=true row with the
    // ORIGINAL provider/model so per-purpose attribution is preserved.
    const cached = this.cache.get(cacheKey);
    if (cached) {
      await this.recordSafe({
        purpose,
        provider: cached.provider,
        model: cached.model,
        promptHash,
        inputHash,
        outputHash: cached.outputHash,
        promptVersion,
        latencyMs: 0,
        inputTokens: cached.inputTokens,
        outputTokens: cached.outputTokens,
        ok: true,
        errorCode: null,
        cacheHit: true,
      });
      return cached.value;
    }

    // R-183 step 2: token bucket. Rejected requests record `rate_limited`
    // against the primary provider so dashboards can see the drop.
    const primary = this.providers[0];
    if (!this.rateLimiter.tryConsume(purpose)) {
      logger.warn({ purpose, provider: primary.config.name }, 'AI call rate-limited');
      await this.recordSafe({
        purpose,
        provider: primary.config.name,
        model: primary.model,
        promptHash,
        inputHash,
        outputHash: null,
        promptVersion,
        latencyMs: 0,
        inputTokens: null,
        outputTokens: null,
        ok: false,
        errorCode: 'rate_limited',
        cacheHit: false,
      });
      return null;
    }

    // R-183 step 3: provider chain. When the chain has >1 entry, each
    // provider gets a single attempt — total work stays bounded. With a
    // single provider we keep the legacy maxRetries behaviour so users
    // who configured only AMD don't lose transient retry coverage.
    const attemptsPerProvider = this.providers.length > 1 ? 1 : this.maxRetries + 1;
    let lastResult: ProviderCallResult | null = null;

    for (let p = 0; p < this.providers.length; p++) {
      const { config, model } = this.providers[p];

      if (config.name === 'mock') {
        const start = Date.now();
        const raw = getMockAiResponse(system);
        const extracted = raw ? extractJson(raw) : null;
        const outputHash = extracted ? sha256(extracted) : null;
        await this.recordSafe({
          purpose,
          provider: 'mock',
          model,
          promptHash,
          inputHash,
          outputHash,
          promptVersion,
          latencyMs: Date.now() - start,
          inputTokens: null,
          outputTokens: null,
          ok: extracted !== null,
          errorCode: extracted === null ? 'empty_response' : null,
          cacheHit: false,
        });
        if (extracted !== null) {
          this.cache.set(cacheKey, {
            value: extracted,
            provider: 'mock',
            model,
            outputHash,
            inputTokens: null,
            outputTokens: null,
          });
        }
        return extracted;
      }

      let result = await this.callProvider(
        config,
        model,
        system,
        user,
        attemptsPerProvider,
        tool,
      );

      // R-185 + closes #819 / #823 / #828: when this call asked for tool_use
      // and the provider rejected the request with a 4xx (typically 400),
      // it almost always means the gateway does not support
      // `tools`/`tool_choice` (older AMD-internal Anthropic-compatible
      // endpoints, or third-party shims). Retry the SAME provider once
      // in legacy text mode before falling through to the next provider —
      // otherwise a deployment that has only AMD configured returns null
      // on every AI route, even though the legacy text path would have
      // worked. The retry is bounded (single attempt, no tool) so we do
      // not amplify load on real 4xx errors.
      if (
        tool &&
        !result.ok &&
        result.errorCode &&
        /^http_4\d\d$/.test(result.errorCode) &&
        result.errorCode !== 'http_429'
      ) {
        logger.warn(
          { provider: config.name, errorCode: result.errorCode, tool: tool.name },
          'AI tool_use rejected with 4xx; retrying provider in text mode',
        );
        const textResult = await this.callProvider(
          config,
          model,
          system,
          user,
          1,
          undefined,
        );
        if (textResult.ok) {
          result = { ...textResult, errorCode: textResult.errorCode };
        }
      }

      lastResult = result;

      await this.recordSafe({
        purpose,
        provider: config.name,
        model,
        promptHash,
        inputHash,
        outputHash: result.outputHash,
        promptVersion,
        latencyMs: result.latencyMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        ok: result.ok && result.value !== null,
        errorCode: result.errorCode,
        cacheHit: false,
      });

      if (result.ok) {
        if (result.value !== null) {
          this.cache.set(cacheKey, {
            value: result.value,
            provider: config.name,
            model,
            outputHash: result.outputHash,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          });
        }
        return result.value;
      }

      // Transport-layer failure (timeout/network/HTTP error). Fall back
      // to the next configured provider.
      logger.warn(
        {
          provider: config.name,
          errorCode: result.errorCode,
          remaining: this.providers.length - p - 1,
        },
        'AI provider failed, attempting fallback',
      );
    }

    return lastResult?.value ?? null;
  }

  private async callProvider(
    config: ProviderConfig,
    model: string,
    system: string,
    user: string,
    maxAttempts: number,
    tool?: ToolDescriptor,
  ): Promise<ProviderCallResult> {
    const { apiKey, buildUrl, buildHeaders, buildBody, parseResponse, name } = config;
    const callStart = Date.now();
    let lastErrorCode: string = 'unknown';

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        const url = buildUrl(model);
        const res = await fetch(url, {
          method: 'POST',
          headers: buildHeaders(apiKey),
          body: JSON.stringify(buildBody(model, system, user, tool)),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!res.ok) {
          const errText = await res.text();
          lastErrorCode = `http_${res.status}`;
          logger.warn(
            { provider: name, status: res.status, attempt, body: errText.slice(0, 200) },
            'AI call non-2xx response',
          );
          // 429 is a hard rate-limit signal — short-circuit retries and
          // let the outer chain fall back to the next provider.
          if (res.status === 429) {
            return {
              ok: false,
              value: null,
              outputHash: null,
              latencyMs: Date.now() - callStart,
              inputTokens: null,
              outputTokens: null,
              errorCode: 'rate_limited',
            };
          }
          // 5xx → retry; 4xx (other than 429) → bail
          if (res.status < 500 && attempt === maxAttempts - 1) {
            return {
              ok: false,
              value: null,
              outputHash: null,
              latencyMs: Date.now() - callStart,
              inputTokens: null,
              outputTokens: null,
              errorCode: lastErrorCode,
            };
          }
          if (res.status < 500) {
            return {
              ok: false,
              value: null,
              outputHash: null,
              latencyMs: Date.now() - callStart,
              inputTokens: null,
              outputTokens: null,
              errorCode: lastErrorCode,
            };
          }
          throw new Error(`${name} API ${res.status}: ${errText}`);
        }

        const data: unknown = await res.json();
        const raw = parseResponse(data);
        const tokens = pickTokenUsage(data);
        const extracted = raw ? extractJson(raw) : null;
        return {
          ok: true,
          value: extracted,
          outputHash: extracted ? sha256(extracted) : null,
          latencyMs: Date.now() - callStart,
          inputTokens: tokens.input ?? null,
          outputTokens: tokens.output ?? null,
          errorCode: extracted === null ? 'empty_response' : null,
        };
      } catch (err: unknown) {
        clearTimeout(timer);
        const errName =
          typeof err === 'object' && err !== null && 'name' in err
            ? String((err as { name: unknown }).name)
            : '';
        const errMessage = err instanceof Error ? err.message : String(err);
        if (errName === 'AbortError') {
          lastErrorCode = 'timeout';
          logger.warn({ attempt, provider: name }, 'AI call timed out');
        } else {
          if (lastErrorCode === 'unknown') lastErrorCode = 'network';
          logger.warn({ err: errMessage, attempt, provider: name }, 'AI call failed');
        }
        if (attempt === maxAttempts - 1) {
          return {
            ok: false,
            value: null,
            outputHash: null,
            latencyMs: Date.now() - callStart,
            inputTokens: null,
            outputTokens: null,
            errorCode: lastErrorCode,
          };
        }
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }

    return {
      ok: false,
      value: null,
      outputHash: null,
      latencyMs: Date.now() - callStart,
      inputTokens: null,
      outputTokens: null,
      errorCode: lastErrorCode,
    };
  }

  // R-182: ai_calls insert must never bubble back to callers. A logging
  // failure (DB down, transient connection error) is strictly less
  // important than serving the AI response, so we swallow + warn.
  private async recordSafe(record: AiCallRecord): Promise<void> {
    try {
      await recordAiCall(record);
    } catch (err) {
      logger.warn({ err, purpose: record.purpose }, 'Failed to record ai_calls row');
    }
  }
}

const globalForAi = globalThis as unknown as { aiClient: AiClient | undefined };
export const aiClient = globalForAi.aiClient ?? new AiClient();
if (process.env.NODE_ENV !== 'production') globalForAi.aiClient = aiClient;

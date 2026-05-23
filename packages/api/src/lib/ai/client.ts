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

interface ProviderConfig {
  name: Provider;
  apiKey: string;
  buildUrl: (model: string) => string;
  buildHeaders: (apiKey: string) => Record<string, string>;
  buildBody: (model: string, system: string, user: string) => object;
  parseResponse: (data: unknown) => string | null;
}

// R-182: callers pass a `purpose` so /api/ai-usage can group by call site.
// `promptVersion` is opaque and defaults to 'v1' until prompts start
// versioning themselves.
export interface AiCompleteOptions {
  purpose: string;
  promptVersion?: string;
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

// AMD internal LLM uses the same Anthropic messages API format,
// just with a different base URL and Ocp-Apim-Subscription-Key header.
// LLM_API_BASE should point to the Anthropic-compatible endpoint,
// e.g. https://llm-api.amd.com/Anthropic
const AMD_BASE = (process.env.LLM_API_BASE || 'https://llm-api.amd.com/Anthropic').replace(
  /\/$/,
  '',
);

const AMD_PROVIDER: Omit<ProviderConfig, 'apiKey'> = {
  name: 'amd',
  buildUrl: () => `${AMD_BASE}/v1/messages`,
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    'x-api-key': 'dummy',
    'anthropic-version': '2023-06-01',
    'Ocp-Apim-Subscription-Key': apiKey,
  }),
  buildBody: (model, system, user) => ({
    model,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: user }],
  }),
  parseResponse: pickFirstContentText,
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
  buildBody: (model, system, user) => ({
    model,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: user }],
  }),
  parseResponse: pickFirstContentText,
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

class AiClient {
  private provider: ProviderConfig | null = null;
  private model: string;
  private maxRetries = 2;
  private timeout = 60000;

  constructor() {
    // R-124: PLANSYNC_AI_MOCK=1 forces a deterministic mock provider so CI
    // can exercise AI code paths without real API keys. Mock takes precedence
    // over any real key so tests stay hermetic even when keys are present.
    const mockEnabled = process.env.PLANSYNC_AI_MOCK === '1';
    const amdKey = process.env.LLM_API_KEY?.trim() || '';
    const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() || '';

    if (mockEnabled) {
      this.provider = { ...MOCK_PROVIDER, apiKey: 'mock' };
      this.model = process.env.PLANSYNC_AI_MOCK_MODEL || 'mock-model';
      logger.info({ provider: 'mock', model: this.model }, 'AI client using mock provider');
    } else if (amdKey) {
      this.provider = { ...AMD_PROVIDER, apiKey: amdKey };
      this.model = process.env.LLM_MODEL_NAME || 'Claude-Sonnet-4.5';
      logger.info({ provider: 'amd', model: this.model }, 'AI client using AMD internal LLM API');
    } else if (anthropicKey) {
      this.provider = { ...ANTHROPIC_PROVIDER, apiKey: anthropicKey };
      this.model = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-20250514';
      logger.info({ provider: 'anthropic' }, 'AI client using Anthropic API');
    } else {
      this.model = '';
      logger.debug('No LLM_API_KEY or ANTHROPIC_API_KEY configured, AI features disabled');
    }
  }

  get isAvailable(): boolean {
    return this.provider !== null;
  }

  get providerName(): string {
    return this.provider?.name ?? 'none';
  }

  // R-143: completion-verify writes the model name onto each run for audit.
  // Returns null when no provider is configured so callers can distinguish
  // "AI unavailable" from "AI returned no result".
  get modelName(): string | null {
    return this.provider ? this.model : null;
  }

  // R-182: third argument accepts either an options bag (`{ purpose }`) or
  // a bare purpose string for ergonomic call sites. When no provider is
  // configured we still emit a 0-latency `ok=false` row with
  // errorCode='unavailable' so /api/ai-usage shows attempted-but-skipped
  // requests rather than silently dropping them.
  async complete(system: string, user: string, opts?: CompleteArg): Promise<string | null> {
    const { purpose, promptVersion = 'v1' } = resolveOptions(opts);
    const inputHash = sha256(`${system}\n---\n${user}`);
    const promptHash = sha256(system);

    if (!this.provider) {
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

    // R-124: mock provider returns canned responses without touching the
    // network. `user` is intentionally unused — it is logged at debug level
    // only — because mock responses are keyed off the system prompt.
    if (this.provider.name === 'mock') {
      logger.debug({ systemLen: system.length, userLen: user.length }, 'AI mock complete');
      const start = Date.now();
      const raw = getMockAiResponse(system);
      const extracted = raw ? extractJson(raw) : null;
      await this.recordSafe({
        purpose,
        provider: 'mock',
        model: this.model,
        promptHash,
        inputHash,
        outputHash: extracted ? sha256(extracted) : null,
        promptVersion,
        latencyMs: Date.now() - start,
        inputTokens: null,
        outputTokens: null,
        ok: extracted !== null,
        errorCode: extracted === null ? 'empty_response' : null,
        cacheHit: false,
      });
      return extracted;
    }

    const { apiKey, buildUrl, buildHeaders, buildBody, parseResponse, name } = this.provider;
    const callStart = Date.now();
    let lastErrorCode: string = 'unknown';

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        const url = buildUrl(this.model);
        const res = await fetch(url, {
          method: 'POST',
          headers: buildHeaders(apiKey),
          body: JSON.stringify(buildBody(this.model, system, user)),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!res.ok) {
          const errText = await res.text();
          lastErrorCode = `http_${res.status}`;
          throw new Error(`${name} API ${res.status}: ${errText}`);
        }

        const data: unknown = await res.json();
        const raw = parseResponse(data);
        const tokens = pickTokenUsage(data);
        const extracted = raw ? extractJson(raw) : null;
        await this.recordSafe({
          purpose,
          provider: name,
          model: this.model,
          promptHash,
          inputHash,
          outputHash: extracted ? sha256(extracted) : null,
          promptVersion,
          latencyMs: Date.now() - callStart,
          inputTokens: tokens.input ?? null,
          outputTokens: tokens.output ?? null,
          ok: extracted !== null,
          errorCode: extracted === null ? 'empty_response' : null,
          cacheHit: false,
        });
        return extracted;
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
        if (attempt === this.maxRetries) {
          await this.recordSafe({
            purpose,
            provider: name,
            model: this.model,
            promptHash,
            inputHash,
            outputHash: null,
            promptVersion,
            latencyMs: Date.now() - callStart,
            inputTokens: null,
            outputTokens: null,
            ok: false,
            errorCode: lastErrorCode,
            cacheHit: false,
          });
          return null;
        }
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    return null;
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

import { logger } from '../logger';
import { getMockAiResponse } from './mock-responses';

function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:\w*)\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) return fenceMatch[1].trim();

  const braceMatch = text.match(/(\{[\s\S]*\})/);
  if (braceMatch) return braceMatch[1].trim();

  return text.trim();
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

  async complete(system: string, user: string): Promise<string | null> {
    if (!this.provider) {
      logger.debug('No AI provider configured, skipping AI call');
      return null;
    }

    // R-124: mock provider returns canned responses without touching the
    // network. `user` is intentionally unused — it is logged at debug level
    // only — because mock responses are keyed off the system prompt.
    if (this.provider.name === 'mock') {
      logger.debug({ systemLen: system.length, userLen: user.length }, 'AI mock complete');
      const raw = getMockAiResponse(system);
      return extractJson(raw);
    }

    const { apiKey, buildUrl, buildHeaders, buildBody, parseResponse, name } = this.provider;

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
          throw new Error(`${name} API ${res.status}: ${errText}`);
        }

        const data: unknown = await res.json();
        const raw = parseResponse(data);
        return raw ? extractJson(raw) : null;
      } catch (err: unknown) {
        clearTimeout(timer);
        const errName =
          typeof err === 'object' && err !== null && 'name' in err
            ? String((err as { name: unknown }).name)
            : '';
        const errMessage = err instanceof Error ? err.message : String(err);
        if (errName === 'AbortError') {
          logger.warn({ attempt, provider: name }, 'AI call timed out');
        } else {
          logger.warn({ err: errMessage, attempt, provider: name }, 'AI call failed');
        }
        if (attempt === this.maxRetries) return null;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    return null;
  }
}

const globalForAi = globalThis as unknown as { aiClient: AiClient | undefined };
export const aiClient = globalForAi.aiClient ?? new AiClient();
if (process.env.NODE_ENV !== 'production') globalForAi.aiClient = aiClient;

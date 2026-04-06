import { logger } from '../logger';

function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:\w*)\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) return fenceMatch[1].trim();

  const braceMatch = text.match(/(\{[\s\S]*\})/);
  if (braceMatch) return braceMatch[1].trim();

  return text.trim();
}

type Provider = 'amd' | 'anthropic';

interface ProviderConfig {
  name: Provider;
  apiKey: string;
  buildUrl: (model: string) => string;
  buildHeaders: (apiKey: string) => Record<string, string>;
  buildBody: (model: string, system: string, user: string) => object;
  parseResponse: (data: any) => string | null;
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
  parseResponse: (data) => data?.content?.[0]?.text || null,
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
  parseResponse: (data) => data?.content?.[0]?.text || null,
};

class AiClient {
  private provider: ProviderConfig | null = null;
  private model: string;
  private maxRetries = 2;
  private timeout = 60000;

  constructor() {
    const amdKey = process.env.LLM_API_KEY?.trim() || '';
    const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() || '';

    if (amdKey) {
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

  async complete(system: string, user: string): Promise<string | null> {
    if (!this.provider) {
      logger.debug('No AI provider configured, skipping AI call');
      return null;
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

        const data = (await res.json()) as any;
        const raw = parseResponse(data);
        return raw ? extractJson(raw) : null;
      } catch (err: any) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          logger.warn({ attempt, provider: name }, 'AI call timed out');
        } else {
          logger.warn({ err: err.message, attempt, provider: name }, 'AI call failed');
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

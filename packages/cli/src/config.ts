import * as path from 'path';

export function parseCustomHeaders(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

const _anthropicBase = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const _anthropicUrl = new URL(_anthropicBase);

export const selfDir = path.dirname(process.argv[1] || __filename);
const _mcpAuto = path.resolve(selfDir, '../../mcp-server/dist/index.js');

export const cfg = {
  apiUrl: process.env.PLANSYNC_API_URL || 'http://localhost:3001',
  apiKey: process.env.PLANSYNC_API_KEY || '',
  user: process.env.PLANSYNC_USER || process.env.USER || 'unknown',
  project: process.env.PLANSYNC_PROJECT || '',
  llmKey: process.env.LLM_API_KEY || '',
  llmBase: (process.env.LLM_API_BASE || 'https://llm-api.amd.com/Anthropic').replace(/\/$/, ''),
  llmModel: process.env.LLM_MODEL_NAME || 'claude-opus-4-6',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-20250514',
  anthropicHostname: _anthropicUrl.hostname,
  anthropicPathPrefix: _anthropicUrl.pathname.replace(/\/$/, ''),
  anthropicCustomHeaders: parseCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS || ''),
  genieOrClaude: process.env.GENIE_BIN || '/proj/verif_release_ro/genie/current/bin/genie',
  mcpServer: process.env.PLANSYNC_MCP_SERVER || _mcpAuto,
  nodeBin: process.env.PLANSYNC_NODE_BIN || process.execPath,
  maxOutputTokens: Number(process.env.PLANSYNC_MAX_OUTPUT_TOKENS) || 8192,
  maxTurns: Number(process.env.PLANSYNC_MAX_TURNS) || 12,
};

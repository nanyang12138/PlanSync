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
  workDir: path.resolve(process.env.PLANSYNC_WORK_DIR || process.cwd()),
  projectName: '',
  verbose: false,
  llmKey: process.env.LLM_API_KEY || '',
  llmBase: (process.env.LLM_API_BASE || 'https://llm-api.amd.com/Anthropic').replace(/\/$/, ''),
  llmModel: process.env.LLM_MODEL_NAME || 'claude-opus-4-6',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-20250514',
  anthropicHostname: _anthropicUrl.hostname,
  anthropicPathPrefix: _anthropicUrl.pathname.replace(/\/$/, ''),
  anthropicCustomHeaders: parseCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS || ''),
  // R-102: portable default. The previous hard-coded
  // `/proj/verif_release_ro/genie/current/bin/genie` path was AMD-internal and
  // failed silently on every other host with `ENOENT`. We fall back to
  // `claude` so that PATH-resolution picks up whatever coding agent the user
  // actually has installed; overrides remain in priority order:
  //   1. `PLANSYNC_CODE_BIN` — preferred, agent-agnostic name
  //   2. `GENIE_BIN`         — legacy AMD-internal name, kept for back-compat
  //   3. `claude`            — generic fallback, resolved via $PATH
  genieOrClaude: process.env.PLANSYNC_CODE_BIN || process.env.GENIE_BIN || 'claude',
  mcpServer: process.env.PLANSYNC_MCP_SERVER || _mcpAuto,
  nodeBin: process.env.PLANSYNC_NODE_BIN || process.execPath,
  maxOutputTokens: Number(process.env.PLANSYNC_MAX_OUTPUT_TOKENS) || 8192,
  maxTurns: Number(process.env.PLANSYNC_MAX_TURNS) || 12,
  // R-070: token budget for in-memory chat history. When the estimated
  // token count exceeds this threshold, `pruneHistory` drops the oldest
  // message pairs (never splitting a `tool_use` / `tool_result` pair) and
  // surfaces a one-line notice to the user. Defaults to 80k tokens, well
  // under the 200k context window of current Claude models while leaving
  // headroom for system prompt + tool schema + new turn output.
  maxHistoryTokens: (() => {
    const raw = Number(process.env.PLANSYNC_MAX_HISTORY_TOKENS);
    return Number.isFinite(raw) && raw > 0 ? raw : 80000;
  })(),
};

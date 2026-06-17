#!/usr/bin/env node
/**
 * Standalone Node entry point for the shell `bin/plansync --exec <taskId>` path
 * (R-062). It performs the same orchestration the in-REPL `/exec` slash
 * command performs:
 *
 *   1. Fetch the task pack via the API.
 *   2. Refuse to launch if there are unresolved drift alerts.
 *   3. Validate the assignee via the shared `resolveExecAssignee` helper (R-060).
 *   4. Pre-register the execution run by POSTing to /tasks/<id>/runs so the
 *      LLM does NOT have to call `plansync_execution_start` itself.
 *   5. Issue an exec-scoped API key (best effort).
 *   6. Build the MCP config + the identical exec-mode prompt used by the CLI
 *      (so both entry points feed the engine the same instructions).
 *   7. Spawn the chosen engine binary (claude-code / genie / codex) inheriting
 *      stdio so the user gets an interactive session.
 *
 * Required env (set by `bin/plansync`):
 *   PLANSYNC_API_URL       e.g. http://localhost:3001
 *   PLANSYNC_API_KEY       caller's API key
 *   PLANSYNC_USER          caller identity
 *   PLANSYNC_PROJECT       project id
 *   _PS_EXEC_TASK_ID       task id (CLI argv[2] fallback if not set)
 *   _PS_EXEC_BIN           absolute path to the engine binary to spawn
 *   _PS_EXEC_HOST          'claude' | 'genie' (defaults to 'genie')
 *   _PS_MCP_SERVER         absolute path to mcp-server dist bundle
 *   _PS_NODE_BIN           absolute path to local node runtime
 */

import * as http from 'http';
import * as https from 'https';
import { spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import * as path from 'path';

import {
  resolveExecAssignee,
  buildExecPrompt,
  buildExecMcpConfigJson,
  openDriftAlerts,
  unwrapTaskPack,
} from './exec-shared.mjs';

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

const env = process.env;

function die(msg, code = 1) {
  process.stderr.write(`${RED}✗ ${msg}${RESET}\n`);
  process.exit(code);
}

const taskId = env._PS_EXEC_TASK_ID || process.argv[2];
const execBin = env._PS_EXEC_BIN || env.GENIE_BIN || '';
// _PS_EXEC_HOST is reserved for callers that want to override the engine
// binary's interpretation (genie vs claude); the actual selection is encoded
// in _PS_EXEC_BIN by bin/plansync — we just keep the variable consumed.
const _execHost = (env._PS_EXEC_HOST || 'genie').toLowerCase();
void _execHost;
const mcpServer = env._PS_MCP_SERVER || '';
const localNodeBin = env._PS_NODE_BIN || process.execPath;
const apiUrl = env.PLANSYNC_API_URL || 'http://localhost:3001';
const apiKey = env.PLANSYNC_API_KEY || '';
const user = env.PLANSYNC_USER || env.USER || '';
const projectId = env.PLANSYNC_PROJECT || '';
const secret = env.PLANSYNC_SECRET || '';

if (!taskId) die('exec-cli: missing taskId (set _PS_EXEC_TASK_ID or pass as argv[2])');
if (!projectId) die('exec-cli: missing PLANSYNC_PROJECT');
if (!apiKey) die('exec-cli: missing PLANSYNC_API_KEY');
if (!user) die('exec-cli: missing PLANSYNC_USER');
if (!execBin) die('exec-cli: missing engine binary (_PS_EXEC_BIN / GENIE_BIN)');
if (!mcpServer) die('exec-cli: missing _PS_MCP_SERVER (mcp-server dist path)');

function apiRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlPath, apiUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const bodyStr = body == null ? null : JSON.stringify(body);
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'x-user-name': user,
      Accept: 'application/json',
    };
    if (bodyStr != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = mod.request(
      {
        method,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c.toString()));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (bodyStr != null) req.write(bodyStr);
    req.end();
  });
}

function detectEngine() {
  if (env.GENIE_AGENT_ENGINE === 'codex') return 'codex';
  if (env.GENIE_AGENT_ENGINE === 'claude-code') return 'claude-code';
  try {
    const r = spawnSync(execBin, ['help'], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
    if (((r.stdout || '') + (r.stderr || '')).includes('Codex CLI')) return 'codex';
  } catch {
    /* fall through */
  }
  return 'claude-code';
}

async function main() {
  process.stderr.write(`\n📋 Fetching task pack for ${taskId}...\n`);
  let taskPack;
  try {
    // Closes #725 / #735 — the route returns
    // `{ data: taskPack }`; unwrap once here so every downstream
    // reader (`taskPack.task`, `openDriftAlerts(taskPack)`,
    // `buildExecPrompt({ taskPack })`) sees the actual pack and
    // not the API envelope. unwrapTaskPack is a no-op on a bare
    // pack, so test fixtures and any future contract change that
    // drops the envelope keep working.
    const response = await apiRequest(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/pack`,
    );
    taskPack = unwrapTaskPack(response);
  } catch (err) {
    die(`Failed to fetch task pack: ${err.message}`);
  }

  const drifts = openDriftAlerts(taskPack);
  if (drifts.length > 0) {
    process.stderr.write(
      `\n${YELLOW}⚠ Task ${taskId} has ${drifts.length} unresolved drift alert(s). Resolve them first.${RESET}\n`,
    );
    drifts.forEach((d) =>
      process.stderr.write(`  • ${d && d.reason ? d.reason : 'unspecified drift'}\n`),
    );
    process.exit(1);
  }

  const taskInfo = (taskPack && taskPack.task) || {};
  const decision = resolveExecAssignee(
    { assignee: taskInfo.assignee, assigneeType: taskInfo.assigneeType },
    user,
  );
  if (!decision.ok) {
    die(decision.reason);
  }

  process.stderr.write(`✓ Assignee validated (${decision.executorType}: ${decision.executorName})\n`);

  let runId = '';
  try {
    const resp = await apiRequest(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/runs`,
      { executorType: decision.executorType, executorName: decision.executorName },
    );
    runId = (resp && resp.data && resp.data.id) || '';
    if (!runId) throw new Error('execution_start returned no runId');
  } catch (err) {
    die(`Failed to register execution: ${err.message}`);
  }
  process.stderr.write(`✓ Execution run registered: ${runId}\n`);

  let scopedKey = null;
  try {
    const resp = await apiRequest('POST', '/api/exec-sessions/issue-token', {
      runId,
      taskId,
      projectId,
    });
    scopedKey = (resp && resp.data && resp.data.key) || null;
  } catch (err) {
    process.stderr.write(
      `${YELLOW}⚠ Could not issue exec-scoped key (${err.message}); spawned session will use full owner key.${RESET}\n`,
    );
  }

  const sessionId = crypto.randomUUID();
  const mcpConfigJson = buildExecMcpConfigJson({
    runId,
    taskId,
    projectId,
    sessionId,
    localNodeBin,
    mcpServerDist: mcpServer,
    apiUrl,
    apiKey: scopedKey ?? apiKey,
    user,
    secret,
  });

  const execPrompt = buildExecPrompt({ taskId, taskPack });

  process.stderr.write(
    `\n${BLUE}→ Entering PlanSync Coding Mode (task: ${taskId}, run: ${runId}, executor: ${decision.executorName})${RESET}\n\n`,
  );

  const engine = detectEngine();
  let spawnArgs;
  let spawnEnv = { ...process.env };
  if (scopedKey) spawnEnv.PLANSYNC_API_KEY = scopedKey;
  if (engine === 'codex') {
    // Register MCP via `codex mcp add` so the spawned codex picks up the
    // exec env vars (mirrors the CLI path's setupCodexMcp logic).
    spawnSync(execBin, ['--', 'mcp', 'remove', 'plansync'], { stdio: 'pipe' });
    const envArgs = [
      '--env', `PLANSYNC_API_URL=${apiUrl}`,
      '--env', `PLANSYNC_API_KEY=${scopedKey ?? apiKey}`,
      '--env', `PLANSYNC_USER=${user}`,
      '--env', `PLANSYNC_SECRET=${secret}`,
      '--env', `PLANSYNC_PROJECT=${projectId}`,
      '--env', `PLANSYNC_EXEC_RUN_ID=${runId}`,
      '--env', `PLANSYNC_EXEC_TASK_ID=${taskId}`,
      '--env', `PLANSYNC_EXEC_SESSION_ID=${sessionId}`,
      '--env', 'LOG_LEVEL=warn',
    ];
    spawnSync(
      execBin,
      ['--', 'mcp', 'add', 'plansync', ...envArgs, '--', localNodeBin, mcpServer],
      { stdio: 'pipe' },
    );
    spawnArgs = ['--', '--full-auto', execPrompt];
  } else {
    spawnArgs = [
      '-p',
      execPrompt,
      '--session-id',
      sessionId,
      '--mcp-config',
      mcpConfigJson,
      '--dangerously-skip-permissions',
    ];
  }

  const child = spawn(execBin, spawnArgs, {
    stdio: 'inherit',
    env: spawnEnv,
    cwd: process.cwd(),
  });

  const onExit = async () => {
    if (engine === 'codex') {
      try {
        spawnSync(execBin, ['--', 'mcp', 'remove', 'plansync'], { stdio: 'pipe' });
      } catch {
        /* best-effort */
      }
    }
    try {
      await apiRequest('POST', '/api/exec-sessions/revoke-token', { runId });
    } catch {
      /* TTL on the exec-scoped key takes care of leaks */
    }
  };

  await new Promise(() => {
    child.on('close', async (code) => {
      await onExit();
      process.stderr.write(`\n${BLUE}← Returned to PlanSync Terminal${RESET}\n\n`);
      process.exit(code ?? 0);
    });
    child.on('error', async (err) => {
      await onExit();
      process.stderr.write(`\n${RED}✗ ${err.message}${RESET}\n\n`);
      process.exit(1);
    });
  });
}

// Allow `node exec-cli.mjs` to function as a script; do nothing when imported.
const isMain = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');
if (isMain) {
  main().catch((err) => die(err && err.message ? err.message : String(err)));
}

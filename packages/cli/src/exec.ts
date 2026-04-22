import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import { execSync, spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import { cfg, selfDir } from './config.js';
import { c, createSpinner } from './ui.js';

// ─── MCP config builder ───────────────────────────────────────────────────────

export function buildMcpConfigArg(
  runId: string,
  taskId: string,
  projectId: string,
  sessionId: string,
  apiKeyOverride?: string,
): string {
  const projectRoot = path.resolve(selfDir, '../../../');
  const localNodeBin = path.join(projectRoot, '.local-runtime', 'node', 'bin', 'node');
  const mcpServerDist = path.join(projectRoot, 'packages', 'mcp-server', 'dist', 'index.js');

  return JSON.stringify({
    mcpServers: {
      plansync: {
        command: localNodeBin,
        args: [mcpServerDist],
        env: {
          PLANSYNC_API_URL: process.env.PLANSYNC_API_URL ?? 'http://localhost:3001',
          PLANSYNC_API_KEY: apiKeyOverride ?? process.env.PLANSYNC_API_KEY ?? '',
          PLANSYNC_USER: process.env.PLANSYNC_USER ?? process.env.USER ?? '',
          PLANSYNC_SECRET: process.env.PLANSYNC_SECRET ?? '',
          PLANSYNC_PROJECT: projectId,
          PLANSYNC_EXEC_RUN_ID: runId,
          PLANSYNC_EXEC_TASK_ID: taskId,
          PLANSYNC_EXEC_SESSION_ID: sessionId,
          LOG_LEVEL: 'warn',
        },
      },
    },
  });
}

// ─── Exec-scoped API key ──────────────────────────────────────────────────────
//
// Issued by the API just before spawning Genie; injected as PLANSYNC_API_KEY
// in the child process env. Carries an execRunId claim that the API uses to
// reject task/plan creation (POST /tasks, /plans, /propose, /activate) even
// when Genie tries to bypass MCP via raw bash + curl.

function postJson<T>(urlStr: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(body);
    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + (parsed.search || ''),
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'x-user-name': cfg.user,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

export async function issueExecScopedKey(
  runId: string,
  taskId: string,
  projectId: string,
): Promise<string | null> {
  try {
    const resp = await postJson<{ data?: { key?: string } }>(
      `${cfg.apiUrl}/api/exec-sessions/issue-token`,
      { runId, taskId, projectId },
    );
    return resp.data?.key ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `${c.yellow}⚠ Could not issue exec-scoped key (${msg}); spawned session will use full owner key.${c.reset}`,
    );
    return null;
  }
}

export async function revokeExecScopedKey(runId: string): Promise<void> {
  try {
    await postJson(`${cfg.apiUrl}/api/exec-sessions/revoke-token`, { runId });
  } catch {
    /* best-effort — TTL on the key will eventually expire it anyway */
  }
}

// ─── Engine detection ─────────────────────────────────────────────────────────

type Engine = 'claude-code' | 'codex';
let _cachedEngine: Engine | null = null;

function detectEngine(): Engine {
  if (_cachedEngine) return _cachedEngine;

  // Explicit env var takes precedence
  const env = process.env.GENIE_AGENT_ENGINE;
  if (env === 'codex') return (_cachedEngine = 'codex');
  if (env === 'claude-code') return (_cachedEngine = 'claude-code');

  // Probe: `genie help` outputs "Codex CLI" when codex engine is active
  try {
    const r = spawnSync(cfg.genieOrClaude, ['help'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000,
    });
    if (((r.stdout ?? '') + (r.stderr ?? '')).includes('Codex CLI')) {
      return (_cachedEngine = 'codex');
    }
  } catch {
    /* fallback to claude-code */
  }

  return (_cachedEngine = 'claude-code');
}

// ─── Codex MCP helpers ───────────────────────────────────────────────────────

function setupCodexMcp(
  runId?: string,
  taskId?: string,
  projectId?: string,
  sessionId?: string,
  apiKeyOverride?: string,
): void {
  const projectRoot = path.resolve(selfDir, '../../../');
  const localNodeBin = path.join(projectRoot, '.local-runtime', 'node', 'bin', 'node');
  const mcpServerDist = path.join(projectRoot, 'packages', 'mcp-server', 'dist', 'index.js');

  // Remove stale config first (ignore errors if not present)
  spawnSync(cfg.genieOrClaude, ['--', 'mcp', 'remove', 'plansync'], { stdio: 'pipe' });

  // Base env vars (always needed)
  const envArgs = [
    '--env',
    `PLANSYNC_API_URL=${process.env.PLANSYNC_API_URL ?? 'http://localhost:3001'}`,
    '--env',
    `PLANSYNC_API_KEY=${apiKeyOverride ?? process.env.PLANSYNC_API_KEY ?? ''}`,
    '--env',
    `PLANSYNC_USER=${process.env.PLANSYNC_USER ?? process.env.USER ?? ''}`,
    '--env',
    `PLANSYNC_SECRET=${process.env.PLANSYNC_SECRET ?? ''}`,
    '--env',
    `PLANSYNC_PROJECT=${projectId ?? cfg.project}`,
    '--env',
    'LOG_LEVEL=warn',
  ];

  // Execution-specific env vars (only for /exec with worktree)
  if (runId && taskId && sessionId) {
    envArgs.push(
      '--env',
      `PLANSYNC_EXEC_RUN_ID=${runId}`,
      '--env',
      `PLANSYNC_EXEC_TASK_ID=${taskId}`,
      '--env',
      `PLANSYNC_EXEC_SESSION_ID=${sessionId}`,
    );
  }

  // Register with codex mcp add
  spawnSync(
    cfg.genieOrClaude,
    ['--', 'mcp', 'add', 'plansync', ...envArgs, '--', localNodeBin, mcpServerDist],
    { stdio: 'pipe' },
  );
}

function cleanupCodexMcp(): void {
  spawnSync(cfg.genieOrClaude, ['--', 'mcp', 'remove', 'plansync'], { stdio: 'pipe' });
}

/** Codex reads AGENTS.md, not CLAUDE.md. Create from engine-agnostic instructions if missing. */
function ensureAgentsMd(dir: string): void {
  const agentsMd = path.join(dir, 'AGENTS.md');
  if (fs.existsSync(agentsMd)) return;

  // AGENTS.md should exist in git. If not (external cwd), copy from source.
  try {
    const projectRoot = path.resolve(selfDir, '../../../');
    const src = path.join(projectRoot, 'claude-md', 'plansync-instructions.md');
    if (fs.existsSync(src)) {
      fs.writeFileSync(agentsMd, fs.readFileSync(src, 'utf8'));
    }
  } catch {
    /* best-effort */
  }
}

// ─── Filesystem helpers ───────────────────────────────────────────────────────

function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// ─── Settings helpers ─────────────────────────────────────────────────────────

function getSettingsPath(): string {
  return path.join(path.resolve(selfDir, '../../../'), '.claude', 'settings.local.json');
}

function patchProjectInSettings(projectId: string): string {
  const settingsPath = getSettingsPath();
  let original = '';
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.mcpServers?.plansync?.env) {
      original = settings.mcpServers.plansync.env.PLANSYNC_PROJECT || '';
      settings.mcpServers.plansync.env.PLANSYNC_PROJECT = projectId;
      const tmp = settingsPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
      fs.renameSync(tmp, settingsPath);
    }
  } catch {
    /* ignore */
  }
  return original;
}

function restoreProjectInSettings(original: string): void {
  const settingsPath = getSettingsPath();
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.mcpServers?.plansync?.env) {
      settings.mcpServers.plansync.env.PLANSYNC_PROJECT = original;
      const tmp = settingsPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
      fs.renameSync(tmp, settingsPath);
    }
  } catch {
    /* ignore */
  }
}

// ─── Raw mode helpers ─────────────────────────────────────────────────────────

/** Disable raw mode before spawning a subprocess that needs a normal terminal. */
export function rawOff(): void {
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
  }
}

/** Re-enable raw mode after a subprocess exits. */
export function rawOn(): void {
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
    } catch {
      /* ignore */
    }
  }
}

// ─── /code command ────────────────────────────────────────────────────────────

export function launchCode(): ReturnType<typeof spawn> {
  const projectRoot = path.resolve(selfDir, '../../../');
  const original = patchProjectInSettings(cfg.project);
  const engine = detectEngine();

  // Codex doesn't read .claude/settings.json — register MCP via codex mcp add
  // Codex reads AGENTS.md, not CLAUDE.md — ensure instructions exist
  if (engine === 'codex') {
    setupCodexMcp();
    ensureAgentsMd(projectRoot);
  }

  // Codex: --full-auto avoids repeated MCP tool permission prompts
  const codeArgs = engine === 'codex' ? ['--', '--full-auto'] : [];

  console.log(`\n${c.blue}→ Entering PlanSync Coding Mode${c.reset}\n`);
  rawOff();
  const child = spawn(cfg.genieOrClaude, codeArgs, {
    stdio: 'inherit',
    env: { ...process.env },
    cwd: projectRoot,
  });

  const restore = () => {
    restoreProjectInSettings(original);
    if (engine === 'codex') cleanupCodexMcp();
    rawOn();
  };
  child.on('close', () => {
    restore();
    // Clear any leftover output from the alternate screen restore, then print separator
    process.stdout.write('\x1b[2J\x1b[H'); // clear screen, cursor to top
    console.log(`${c.blue}← Returned to PlanSync Terminal${c.reset}\n`);
  });
  child.on('error', (err) => {
    restore();
    console.log(`\n${c.red}✗ ${err.message}${c.reset}\n`);
  });
  return child;
}

// ─── /exec command ────────────────────────────────────────────────────────────

export async function launchExec(
  taskId: string,
  apiGet: <T>(path: string) => Promise<T>,
  apiPost: <T>(path: string, body?: unknown) => Promise<T>,
): Promise<void> {
  let taskPack: unknown;
  try {
    taskPack = await apiGet<unknown>(`/api/projects/${cfg.project}/tasks/${taskId}/pack`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`\n${c.red}✗ Failed to fetch task pack: ${msg}${c.reset}\n`);
    return;
  }

  const pack = taskPack as {
    driftAlerts?: Array<{ status: string; reason: string }>;
    task?: { assignee?: string | null; assigneeType?: string | null };
  };
  const openDrifts = (pack.driftAlerts ?? []).filter((d) => d.status === 'open');
  if (openDrifts.length > 0) {
    console.log(
      `\n${c.yellow}⚠ Task has ${openDrifts.length} unresolved drift alert(s). Resolve them first.${c.reset}\n`,
    );
    openDrifts.forEach((d) => console.log(`  • ${d.reason}`));
    console.log('');
    return;
  }

  // /exec must be invoked on an agent-assigned task; the executor identity is the assignee.
  const taskInfo = pack.task ?? {};
  const assignee = taskInfo.assignee;
  const assigneeType = taskInfo.assigneeType;
  if (!assignee || assigneeType !== 'agent') {
    console.log(
      `\n${c.red}✗ /exec requires the task to be assigned to an agent member. Current assignee: ${assignee ?? 'none'} (${assigneeType ?? 'unassigned'}).${c.reset}\n`,
    );
    return;
  }

  // Pre-register the execution run as the assigned agent. The spawned engine
  // receives runId via PLANSYNC_EXEC_RUN_ID env (see buildMcpConfigArg) and
  // calls plansync_exec_context to retrieve it — no execution_start from the LLM.
  let runId: string;
  try {
    const startResp = await apiPost<{ data?: { id?: string } }>(
      `/api/projects/${cfg.project}/tasks/${taskId}/runs`,
      { executorType: 'agent', executorName: assignee },
    );
    runId = startResp?.data?.id ?? '';
    if (!runId) throw new Error('execution_start returned no runId');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`\n${c.red}✗ Failed to register execution: ${msg}${c.reset}\n`);
    return;
  }

  const execPrompt = [
    `You are about to execute PlanSync task ${taskId}.`,
    '',
    'This session is launched in PlanSync exec mode. The execution run has ALREADY',
    'been registered for you (runId in env PLANSYNC_EXEC_RUN_ID). Call',
    'plansync_exec_context FIRST to retrieve runId and full task context.',
    '',
    'Do NOT call plansync_execution_start — only one running execution is allowed',
    'per task and yours is already active.',
    '',
    'IMPORTANT: Do NOT write any code yet.',
    'First, present your implementation approach for user approval.',
    'After approval: implement using your tools, then call plansync_execution_complete',
    'with the runId from plansync_exec_context.',
    '',
    'FORBIDDEN: Do NOT call plansync_plan_create, plansync_plan_propose, plansync_plan_activate, or plansync_plan_reactivate.',
    'A plan already exists. You are here to EXECUTE a task within the existing plan, not to create a new one.',
    '',
    'Task Pack:',
    JSON.stringify(taskPack, null, 2),
  ].join('\n');

  const projectRoot = path.resolve(selfDir, '../../../');
  const original = patchProjectInSettings(cfg.project);
  const engine = detectEngine();
  const sessionId = crypto.randomUUID();

  const scopedKey = await issueExecScopedKey(runId, taskId, cfg.project);
  const mcpConfigArg = buildMcpConfigArg(
    runId,
    taskId,
    cfg.project,
    sessionId,
    scopedKey ?? undefined,
  );

  // Codex doesn't read .claude/settings.json — register MCP via codex mcp add (with exec env vars)
  // Codex reads AGENTS.md, not CLAUDE.md — ensure instructions exist
  if (engine === 'codex') {
    setupCodexMcp(runId, taskId, cfg.project, sessionId, scopedKey ?? undefined);
    ensureAgentsMd(projectRoot);
  }

  const restore = () => {
    restoreProjectInSettings(original);
    if (engine === 'codex') cleanupCodexMcp();
  };

  const spawnArgs =
    engine === 'codex'
      ? ['--', '--full-auto', execPrompt]
      : ['-p', execPrompt, '--session-id', sessionId, '--mcp-config', mcpConfigArg];

  console.log(
    `\n${c.blue}→ Entering PlanSync Coding Mode (task: ${taskId}, run: ${runId}, executor: ${assignee})${c.reset}\n`,
  );
  rawOff();
  const child = spawn(cfg.genieOrClaude, spawnArgs, {
    stdio: 'inherit',
    env: scopedKey ? { ...process.env, PLANSYNC_API_KEY: scopedKey } : { ...process.env },
    cwd: projectRoot,
  });

  await new Promise<void>((resolve) => {
    child.on('close', async () => {
      restore();
      rawOn();
      await revokeExecScopedKey(runId);
      console.log(`\n${c.blue}← Returned to PlanSync Terminal${c.reset}\n`);
      resolve();
    });
    child.on('error', async (err) => {
      restore();
      rawOn();
      await revokeExecScopedKey(runId);
      console.log(`\n${c.red}✗ ${err.message}${c.reset}\n`);
      resolve();
    });
  });
}

// ─── /exec direct (takes taskPack, no apiGet) ────────────────────────────────

function buildExecPrompt(taskPack: unknown): string {
  return [
    'You are about to execute a PlanSync task. Read the task pack below carefully.',
    '',
    'This session is launched in PlanSync exec mode. The execution run has ALREADY',
    'been registered (runId in env PLANSYNC_EXEC_RUN_ID). Call plansync_exec_context',
    'FIRST to retrieve runId and task context.',
    '',
    'Do NOT call plansync_execution_start — only one running execution is allowed',
    'per task and yours is already active.',
    '',
    'IMPORTANT: Do NOT write any code yet.',
    'First, present your implementation approach for user approval.',
    'After approval: implement using your tools, then call plansync_execution_complete.',
    '',
    'FORBIDDEN: Do NOT call plansync_plan_create, plansync_plan_propose, plansync_plan_activate, or plansync_plan_reactivate.',
    'A plan already exists. You are here to EXECUTE a task within the existing plan, not to create a new one.',
    '',
    'Task Pack:',
    JSON.stringify(taskPack, null, 2),
  ].join('\n');
}

async function launchExecDirect(
  taskId: string,
  runId: string,
  projectId: string,
  taskPack: unknown,
  options: { autonomous?: boolean },
): Promise<void> {
  const pack = taskPack as { driftAlerts?: Array<{ status: string; reason: string }> };
  const openDrifts = (pack.driftAlerts ?? []).filter((d) => d.status === 'open');
  if (openDrifts.length > 0) {
    console.log(
      `\n${c.yellow}⚠ Task has ${openDrifts.length} unresolved drift alert(s). Resolve them first.${c.reset}\n`,
    );
    openDrifts.forEach((d) => console.log(`  • ${d.reason}`));
    console.log('');
    return;
  }

  const engine = detectEngine();
  const sessionId = crypto.randomUUID();
  const scopedKey = await issueExecScopedKey(runId, taskId, projectId);
  const mcpConfigArg = buildMcpConfigArg(
    runId,
    taskId,
    projectId,
    sessionId,
    scopedKey ?? undefined,
  );
  const cwd = process.cwd();
  const childEnv: NodeJS.ProcessEnv = scopedKey
    ? { ...process.env, PLANSYNC_API_KEY: scopedKey }
    : { ...process.env };

  console.log(`\n${c.blue}→ Launching Genie for task ${taskId} (Run: ${runId})${c.reset}`);
  console.log(
    `  ${c.dim}Mode: ${options.autonomous ? 'autonomous' : 'interactive'} (no worktree — read-only install)${c.reset}`,
  );
  console.log(`  ${c.dim}Engine: ${engine}${c.reset}\n`);

  // Setup codex MCP and instructions if needed
  if (engine === 'codex') {
    setupCodexMcp(runId, taskId, projectId, sessionId, scopedKey ?? undefined);
    ensureAgentsMd(cwd);
  }

  const phase1Prompt = options.autonomous
    ? buildAutonomousPrompt(cwd)
    : [
        'start',
        '',
        'PHASE 1 INSTRUCTION: After writing your implementation plan to the plan file,',
        'STOP. Do NOT proceed to implementation in this phase.',
        'The user will review and approve your plan in the next interactive phase.',
      ].join('\n');
  const phase1Label = options.autonomous
    ? `Executing task autonomously (${taskId})...`
    : 'Generating implementation plan...';

  let codexThreadId: string | null = null;

  const phase1ExitCode = await new Promise<number | null>((resolve) => {
    let spawnArgs: string[];
    if (engine === 'codex') {
      spawnArgs = [
        '--',
        'exec',
        phase1Prompt,
        '--json',
        ...(options.autonomous ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--full-auto']),
      ];
    } else {
      spawnArgs = [
        '-p',
        phase1Prompt,
        '--session-id',
        sessionId,
        '--mcp-config',
        mcpConfigArg,
        ...(options.autonomous ? ['--dangerously-skip-permissions'] : []),
      ];
    }
    const spinner = createSpinner(phase1Label);
    spinner.start();
    if (!options.autonomous) rawOff();
    const child = spawn(cfg.genieOrClaude, spawnArgs, {
      stdio: [options.autonomous ? 'ignore' : 'inherit', 'pipe', 'pipe'],
      env: childEnv,
      cwd,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      if (engine === 'codex' && !codexThreadId) {
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.type === 'thread.started' && evt.thread_id) {
              codexThreadId = evt.thread_id;
            }
          } catch {
            /* not JSON */
          }
        }
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const cleanup = () => {
      spinner.stop();
      child.kill('SIGINT');
    };
    process.once('SIGINT', cleanup);
    child.on('close', (code) => {
      process.removeListener('SIGINT', cleanup);
      if (code === 0)
        spinner.done(
          options.autonomous ? 'Autonomous execution complete.' : 'Plan generation complete.',
        );
      else if (code === 130)
        spinner.fail(
          options.autonomous
            ? 'Execution interrupted by user.'
            : 'Plan generation interrupted by user.',
        );
      else spinner.fail(`Exited with status ${code ?? 'unknown'}.`);
      // Codex --json outputs JSONL events — not useful for the user
      if (engine !== 'codex' && stdout.trim()) process.stdout.write(stdout);
      if (engine !== 'codex' && stderr.trim()) process.stderr.write(stderr);
      if (!options.autonomous) rawOn();
      resolve(code);
    });
    child.on('error', (err) => {
      process.removeListener('SIGINT', cleanup);
      spinner.fail(`Failed: ${err.message}`);
      if (!options.autonomous) rawOn();
      resolve(null);
    });
  });

  let isEarlyExit = phase1ExitCode !== 0 && phase1ExitCode !== null;
  if (!options.autonomous && !isEarlyExit) {
    let phase2Args: string[];
    if (engine === 'codex') {
      phase2Args = codexThreadId
        ? ['--', 'resume', codexThreadId, '--full-auto']
        : ['--', 'resume', '--last', '--full-auto'];
    } else {
      phase2Args = ['--resume', sessionId, '--mcp-config', mcpConfigArg];
    }
    console.log(`\n${c.blue}→ Resuming session for interactive review…${c.reset}\n`);
    rawOff();
    const phase2 = spawnSync(cfg.genieOrClaude, phase2Args, {
      stdio: 'inherit',
      env: childEnv,
      cwd,
    });
    rawOn();
    if (phase2.status !== 0 && phase2.status !== null) isEarlyExit = true;
  }

  // Cleanup codex MCP
  if (engine === 'codex') {
    cleanupCodexMcp();
  }

  await revokeExecScopedKey(runId);

  if (isEarlyExit) {
    const reason =
      phase1ExitCode === 130
        ? 'Execution interrupted by user (SIGINT).'
        : `Genie exited with status ${phase1ExitCode}.`;
    failRun(projectId, taskId, runId, reason);
  }
  console.log(`\n${c.blue}← Genie closed (task: ${taskId}, run: ${runId})${c.reset}\n`);
}

// ─── Worktree helpers ─────────────────────────────────────────────────────────

function patchTask(projectId: string, taskId: string, body: Record<string, unknown>): void {
  try {
    const url = `${cfg.apiUrl}/api/projects/${projectId}/tasks/${taskId}`;
    const bodyStr = JSON.stringify(body);
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'x-user-name': cfg.user,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      () => {
        /* response ignored */
      },
    );
    req.setTimeout(5000, () => req.destroy());
    req.on('error', () => {
      /* best-effort */
    });
    req.write(bodyStr);
    req.end();
  } catch {
    /* best-effort */
  }
}

function failRun(
  projectId: string,
  taskId: string,
  runId: string,
  outputSummary: string,
  branchName?: string,
): void {
  try {
    const url = `${cfg.apiUrl}/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`;
    const body: Record<string, unknown> = { status: 'failed', outputSummary };
    if (branchName) body.branchName = branchName;
    const bodyStr = JSON.stringify(body);
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'x-user-name': cfg.user,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      () => {
        /* response ignored — fire-and-forget */
      },
    );
    req.setTimeout(5000, () => req.destroy());
    req.on('error', () => {
      /* best-effort */
    });
    req.write(bodyStr);
    req.end();
  } catch {
    /* best-effort */
  }
}

function preserveAndRemoveWorktree(
  worktreeDir: string,
  taskId: string,
  runId: string,
  projectId: string,
  options: { autonomous?: boolean } = {},
): string | null {
  const projectRoot = path.resolve(selfDir, '../../../');
  let createdBranch: string | null = null;
  try {
    // Clean up CLI-generated setup files before checking for meaningful changes.
    // .exec-meta.json is an untracked file created during worktree setup.
    // CLAUDE.md had a worktree constraint appended — restore from HEAD.
    try {
      const metaPath = path.join(worktreeDir, '.exec-meta.json');
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    } catch {
      /* ignore */
    }
    try {
      execSync(`git -C "${worktreeDir}" checkout HEAD -- CLAUDE.md`, { stdio: 'pipe' });
    } catch {
      /* ignore — CLAUDE.md may not exist at HEAD */
    }
    try {
      execSync(`git -C "${worktreeDir}" checkout HEAD -- AGENTS.md`, { stdio: 'pipe' });
    } catch {
      /* ignore — AGENTS.md may not exist at HEAD */
    }

    const status = execSync(`git -C "${worktreeDir}" status --porcelain`, {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    const wtHead = execSync(`git -C "${worktreeDir}" rev-parse HEAD`, {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    const mainHead = execSync(`git rev-parse HEAD`, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();

    if (status || wtHead !== mainHead) {
      const branchName = `plansync/exec-${taskId.slice(0, 8)}-${runId.slice(-6)}`;
      if (status) {
        execSync(`git -C "${worktreeDir}" add -A`, { stdio: 'pipe' });
        execSync(`git -C "${worktreeDir}" commit -m "chore: PlanSync task execution (${taskId})"`, {
          stdio: 'pipe',
        });
      }
      execSync(`git -C "${worktreeDir}" branch "${branchName}"`, { stdio: 'pipe' });
      createdBranch = branchName;
      console.log(`\n${c.green}✓ Changes saved to branch: ${branchName}${c.reset}`);
      console.log(`  Review:  git diff HEAD...${branchName}`);
      console.log(`  Merge:   git merge ${branchName}\n`);

      // Prompt to push and create a GitHub PR (only if a remote is configured)
      let prUrl: string | undefined;
      let remoteUrl = '';
      let hasRemote = false;
      try {
        remoteUrl = execSync(`git remote get-url origin`, {
          cwd: projectRoot,
          encoding: 'utf8',
          stdio: 'pipe',
        }).trim();
        hasRemote = true;
      } catch {
        /* no remote configured — skip prompt */
      }

      if (hasRemote) {
        if (options.autonomous) {
          console.log(
            `  Push & PR: git push origin ${branchName} && gh pr create --head ${branchName}\n`,
          );
        } else {
          rawOff();
          process.stdout.write(`Push to GitHub and create PR? [y/N] `);
          const readResult = spawnSync('bash', ['-c', 'read ans && printf "%s" "$ans"'], {
            stdio: ['inherit', 'pipe', 'inherit'],
          });
          rawOn();
          const answer = (readResult.stdout?.toString() ?? '').trim().toLowerCase();
          console.log();

          if (answer === 'y' || answer === 'yes') {
            let pushOk = false;
            try {
              execSync(`git push origin "${branchName}"`, { cwd: projectRoot, stdio: 'inherit' });
              pushOk = true;
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.log(`${c.red}✗ Push failed: ${msg}${c.reset}\n`);
            }

            if (pushOk) {
              let defaultBranch = 'master';
              try {
                defaultBranch =
                  execSync(`git rev-parse --abbrev-ref origin/HEAD`, {
                    cwd: projectRoot,
                    encoding: 'utf8',
                    stdio: 'pipe',
                  })
                    .trim()
                    .replace(/^origin\//, '') || 'master';
              } catch {
                /* fallback to master */
              }

              try {
                const prTitle = `chore: PlanSync task execution (${taskId.slice(0, 8)})`;
                const prBody = `Automated execution of PlanSync task (${taskId}).\n\nCreated by PlanSync /exec.`;
                const prResult = spawnSync(
                  'gh',
                  [
                    'pr',
                    'create',
                    '--head',
                    branchName,
                    '--base',
                    defaultBranch,
                    '--title',
                    prTitle,
                    '--body',
                    prBody,
                  ],
                  { encoding: 'utf8', cwd: projectRoot, stdio: 'pipe' },
                );
                if (prResult.status !== 0) {
                  throw new Error(prResult.stderr || prResult.stdout || 'gh pr create failed');
                }
                prUrl =
                  (prResult.stdout ?? '').trim().match(/https?:\/\/\S+/)?.[0] ??
                  (prResult.stdout ?? '').trim();
                if (prUrl) {
                  console.log(`\n${c.green}✓ PR created: ${prUrl}${c.reset}\n`);
                }
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes('Enterprise Managed User')) {
                  console.log(
                    `${c.yellow}⚠ PR creation skipped: GitHub Enterprise Managed User accounts cannot create PRs via API.${c.reset}`,
                  );
                  const match = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
                  const webUrl = match
                    ? `https://github.com/${match[1]}/pull/new/${branchName}`
                    : '';
                  if (webUrl) {
                    console.log(`  Create PR in browser: ${webUrl}\n`);
                  } else {
                    console.log(
                      `  Create it manually in the GitHub web UI for branch: ${branchName}\n`,
                    );
                  }
                } else {
                  console.log(`${c.red}✗ PR creation failed: ${msg}${c.reset}`);
                  console.log(`  Run manually: gh pr create --head ${branchName}\n`);
                }
              }
            }
          }
        } // end else (interactive mode)
      }

      // Single API patch with all available data
      patchTask(projectId, taskId, {
        branchName,
        ...(prUrl ? { prUrl } : {}),
      });
    }
  } catch {
    /* best-effort */
  }

  try {
    execSync(`git worktree remove --force "${worktreeDir}"`, { cwd: projectRoot, stdio: 'pipe' });
  } catch {
    /* ignore */
  }
  return createdBranch;
}

// ─── Autonomous execution prompt ─────────────────────────────────────────────

function buildAutonomousPrompt(worktreeDir: string): string {
  const projectRoot = path.resolve(worktreeDir, '../../');
  return [
    'You are in AUTONOMOUS execution mode. Do NOT wait for user approval.',
    '',
    '⚠ CRITICAL PATH ISOLATION — read carefully:',
    `  Your working directory (worktree): ${worktreeDir}`,
    `  Main repo root (DO NOT EDIT directly): ${projectRoot}`,
    '  ALL file edits MUST use paths inside your working directory.',
    `  When file search returns a path like "${projectRoot}/packages/foo.ts",`,
    `  you MUST use "${worktreeDir}/packages/foo.ts" instead.`,
    `  NEVER edit files whose path starts with "${projectRoot}/" — those are the main repo.`,
    '',
    '1. Call plansync_exec_context → get taskPack, confirm execMode=true',
    '2. Plan internally (no user interaction needed)',
    '3. Determine the correct test command by checking:',
    '   - package.json scripts.test',
    '   - Makefile test target',
    '   - pytest.ini / jest.config.js',
    '   - .github/workflows for test commands',
    '   - Fall back to: npm test / pytest / go test ./...',
    '4. Implement using your available tools (file editing, shell commands, search)',
    '   (all file edit paths must start with your worktree dir above)',
    '5. Run tests. If they fail: fix and retry (max 3 attempts)',
    '6. Call plansync_execution_complete with SPECIFIC deliverablesMet:',
    '   GOOD: "Implemented POST /auth/login with JWT; 12/12 tests pass (npm test)"',
    '   BAD: "all done", "completed", "requirements met" → REJECTED by verifier',
    '',
    'FORBIDDEN: plansync_plan_create, plansync_plan_propose, plansync_plan_activate, plansync_plan_reactivate',
  ].join('\n');
}

// ─── Auto-exec (git worktree sandbox) ────────────────────────────────────────

export async function launchAutoExec(
  taskId: string,
  runId: string,
  projectId: string,
  _taskPack: unknown,
  options: { autonomous?: boolean } = {},
): Promise<void> {
  // Auto-repair ~/.claude.json if corrupted (e.g. from a previous concurrent write).
  // claude-code rebuilds its own fields on startup, so resetting to {} is safe.
  const claudeConfigPath = path.join(os.homedir(), '.claude.json');
  try {
    JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8'));
  } catch {
    const bak = claudeConfigPath + '.bak';
    try {
      fs.copyFileSync(claudeConfigPath, bak);
    } catch {
      /* file may not exist */
    }
    fs.writeFileSync(claudeConfigPath, '{}');
    console.log(
      `${c.yellow}⚠ ~/.claude.json was corrupted and has been reset (backup: ${bak})${c.reset}`,
    );
  }

  const projectRoot = path.resolve(selfDir, '../../../');

  // Non-owner: cannot create worktrees in admin's directory, fall back to launchExec
  if (!isWritable(projectRoot)) {
    return launchExecDirect(taskId, runId, projectId, _taskPack, options);
  }

  const worktreeDir = path.join(projectRoot, '.plansync-exec', runId);

  try {
    execSync(`git worktree add --detach "${worktreeDir}"`, { cwd: projectRoot, stdio: 'pipe' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`\n${c.red}✗ Failed to create worktree: ${msg}${c.reset}\n`);
    return;
  }

  const sessionId = crypto.randomUUID();
  const scopedKey = await issueExecScopedKey(runId, taskId, projectId);
  const mcpConfigArg = buildMcpConfigArg(
    runId,
    taskId,
    projectId,
    sessionId,
    scopedKey ?? undefined,
  );
  const childEnv: NodeJS.ProcessEnv = scopedKey
    ? { ...process.env, PLANSYNC_API_KEY: scopedKey }
    : { ...process.env };

  const metaPath = path.join(worktreeDir, '.exec-meta.json');
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      { taskId, runId, sessionId, projectId, startedAt: new Date().toISOString() },
      null,
      2,
    ),
  );

  // Layer 2: append path constraint to instruction files so both phases are protected
  const constraint = [
    '',
    '---',
    '',
    '## EXEC WORKTREE PATH CONSTRAINT',
    '',
    'You are running inside an isolated exec worktree.',
    `Working directory: ${worktreeDir}`,
    '',
    'ALL file operations must use paths within this directory.',
    `If file search returns a path like ${projectRoot}/packages/..., use ${worktreeDir}/packages/... instead.`,
    `NEVER edit files whose path starts with ${projectRoot}/ — those are the main repository.`,
  ].join('\n');

  // Claude Code reads CLAUDE.md
  const claudeMdPath = path.join(worktreeDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    fs.appendFileSync(claudeMdPath, constraint);
  }

  // Codex reads AGENTS.md — ensure instructions + constraint exist
  const agentsMdPath = path.join(worktreeDir, 'AGENTS.md');
  ensureAgentsMd(worktreeDir);
  if (fs.existsSync(agentsMdPath)) {
    fs.appendFileSync(agentsMdPath, constraint);
  }

  const phase1Prompt = options.autonomous
    ? buildAutonomousPrompt(worktreeDir)
    : [
        'start',
        '',
        'PHASE 1 INSTRUCTION: After writing your implementation plan to the plan file,',
        'STOP. Do NOT proceed to implementation in this phase.',
        'The user will review and approve your plan in the next interactive phase.',
      ].join('\n');
  const phase1Label = options.autonomous
    ? `Executing task autonomously (${taskId})...`
    : 'Generating implementation plan...';

  const engine = detectEngine();

  console.log(`\n${c.blue}→ Launching Genie sandbox for task ${taskId} (Run: ${runId})${c.reset}`);
  console.log(`  ${c.dim}Mode:     ${options.autonomous ? 'autonomous' : 'interactive'}${c.reset}`);
  console.log(`  ${c.dim}Engine:   ${engine}${c.reset}`);
  console.log(`  ${c.dim}Worktree: ${worktreeDir}${c.reset}`);
  console.log(`  ${c.dim}Session:  ${sessionId}${c.reset}\n`);

  // Setup codex MCP if needed (codex uses `mcp add`, not `--mcp-config`)
  if (engine === 'codex') {
    setupCodexMcp(runId, taskId, projectId, sessionId, scopedKey ?? undefined);
  }

  // ─── Phase 1: generate plan (behind spinner) ──────────────────────────────

  let codexThreadId: string | null = null;

  const phase1ExitCode = await new Promise<number | null>((resolve) => {
    let spawnArgs: string[];
    if (engine === 'codex') {
      spawnArgs = [
        '--',
        'exec',
        phase1Prompt,
        '--json',
        ...(options.autonomous ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--full-auto']),
      ];
    } else {
      spawnArgs = [
        '-p',
        phase1Prompt,
        '--session-id',
        sessionId,
        '--mcp-config',
        mcpConfigArg,
        ...(options.autonomous ? ['--dangerously-skip-permissions'] : []),
      ];
    }

    // Both modes: buffer output behind a spinner
    // Autonomous: stdin ignored; Interactive: stdin inherited (safety net for permission prompts)
    const spinner = createSpinner(phase1Label);
    spinner.start();
    if (!options.autonomous) rawOff();

    const child = spawn(cfg.genieOrClaude, spawnArgs, {
      stdio: [options.autonomous ? 'ignore' : 'inherit', 'pipe', 'pipe'],
      env: childEnv,
      cwd: worktreeDir,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;

      // Codex: parse thread_id from first JSONL event
      if (engine === 'codex' && !codexThreadId) {
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.type === 'thread.started' && evt.thread_id) {
              codexThreadId = evt.thread_id;
            }
          } catch {
            /* not JSON, skip */
          }
        }
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    const cleanup = () => {
      spinner.stop();
      child.kill('SIGINT');
    };
    process.once('SIGINT', cleanup);

    child.on('close', (code) => {
      process.removeListener('SIGINT', cleanup);
      if (code === 0) {
        spinner.done(
          options.autonomous ? 'Autonomous execution complete.' : 'Plan generation complete.',
        );
      } else if (code === 130) {
        spinner.fail(
          options.autonomous
            ? 'Execution interrupted by user.'
            : 'Plan generation interrupted by user.',
        );
      } else {
        spinner.fail(`Exited with status ${code ?? 'unknown'}.`);
      }
      // Codex --json outputs JSONL events — not useful for the user
      if (engine !== 'codex' && stdout.trim()) process.stdout.write(stdout);
      if (engine !== 'codex' && stderr.trim()) process.stderr.write(stderr);
      if (!options.autonomous) rawOn();
      resolve(code);
    });
    child.on('error', (err) => {
      process.removeListener('SIGINT', cleanup);
      spinner.fail(`Failed: ${err.message}`);
      if (!options.autonomous) rawOn();
      resolve(null);
    });
  });

  // ─── Persist codex thread ID for interrupted run recovery ─────────────────

  if (engine === 'codex' && codexThreadId) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      meta.codexThreadId = codexThreadId;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } catch {
      /* best-effort */
    }
  }

  // ─── Phase 2: interactive review ──────────────────────────────────────────

  let isEarlyExit = phase1ExitCode !== 0 && phase1ExitCode !== null;

  if (!options.autonomous) {
    if (isEarlyExit) {
      // Phase 1 was interrupted — skip resume session (nothing to resume)
      console.log(`${c.dim}Skipping interactive review (session was interrupted).${c.reset}\n`);
    } else {
      // Resume session for human plan review
      let phase2Args: string[];
      if (engine === 'codex') {
        if (!codexThreadId) {
          console.log(
            `${c.yellow}⚠ Could not parse codex thread ID — falling back to --last${c.reset}`,
          );
          phase2Args = ['--', 'resume', '--last', '--full-auto'];
        } else {
          phase2Args = ['--', 'resume', codexThreadId, '--full-auto'];
        }
      } else {
        phase2Args = ['--resume', sessionId, '--mcp-config', mcpConfigArg];
      }

      console.log(`\n${c.blue}→ Resuming session for interactive review…${c.reset}\n`);
      rawOff();
      const phase2 = spawnSync(cfg.genieOrClaude, phase2Args, {
        stdio: 'inherit',
        env: childEnv,
        cwd: worktreeDir,
      });
      rawOn();
      // If phase 2 was also interrupted, treat as early exit
      if (phase2.status !== 0 && phase2.status !== null) {
        isEarlyExit = true;
      }
    }
  }

  // Cleanup codex MCP registration
  if (engine === 'codex') {
    cleanupCodexMcp();
  }

  await revokeExecScopedKey(runId);

  const branchName = preserveAndRemoveWorktree(worktreeDir, taskId, runId, projectId, {
    autonomous: options.autonomous,
  });

  if (isEarlyExit) {
    const reason =
      phase1ExitCode === 130
        ? 'Execution interrupted by user (SIGINT).'
        : `Genie exited with status ${phase1ExitCode}.`;
    failRun(projectId, taskId, runId, reason, branchName ?? undefined);
    console.log(`\n${c.blue}← Genie sandbox closed (task: ${taskId}, run: ${runId})${c.reset}`);
    console.log(
      `${c.dim}Run marked as failed. Task will be set to 'blocked' if no other runs are active.${c.reset}\n`,
    );
  } else {
    console.log(`\n${c.blue}← Genie sandbox closed (task: ${taskId}, run: ${runId})${c.reset}`);
    console.log(
      `${c.yellow}⚠ Execution was handled inside Genie.` +
        ` Do NOT call plansync_execution_complete from PlanSync Terminal —` +
        ` Genie handles it.${c.reset}\n`,
    );
  }
}

// ─── Interrupted run recovery ─────────────────────────────────────────────────

export interface InterruptedExec {
  taskId: string;
  runId: string;
  sessionId: string;
  projectId: string;
  worktreeDir: string;
  codexThreadId?: string;
}

export function scanInterruptedExecs(): InterruptedExec[] {
  const projectRoot = path.resolve(selfDir, '../../../');
  const execSandboxDir = path.join(projectRoot, '.plansync-exec');
  const result: InterruptedExec[] = [];

  if (!fs.existsSync(execSandboxDir)) return result;

  for (const entry of fs.readdirSync(execSandboxDir)) {
    const dir = path.join(execSandboxDir, entry);
    const metaFile = path.join(dir, '.exec-meta.json');
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      result.push({ ...meta, worktreeDir: dir });
    } catch {
      try {
        execSync(`git worktree remove --force "${dir}"`, { cwd: projectRoot, stdio: 'pipe' });
      } catch {
        /* ignore */
      }
    }
  }
  return result;
}

export function resumeInterruptedExec(run: InterruptedExec): void {
  const engine = detectEngine();

  console.log(`\n${c.blue}→ Resuming Genie for task ${run.taskId.slice(0, 8)}…${c.reset}\n`);
  rawOff();

  if (engine === 'codex') {
    setupCodexMcp(run.runId, run.taskId, run.projectId, run.sessionId);
    const resumeId = run.codexThreadId || run.sessionId;
    const resumeArgs = run.codexThreadId
      ? ['--', 'resume', resumeId, '--full-auto']
      : ['--', 'resume', '--last', '--full-auto'];
    spawnSync(cfg.genieOrClaude, resumeArgs, {
      stdio: 'inherit',
      env: { ...process.env },
      cwd: run.worktreeDir,
    });
    cleanupCodexMcp();
  } else {
    const mcpCfg = buildMcpConfigArg(run.runId, run.taskId, run.projectId, run.sessionId);
    spawnSync(cfg.genieOrClaude, ['--resume', run.sessionId, '--mcp-config', mcpCfg], {
      stdio: 'inherit',
      env: { ...process.env },
      cwd: run.worktreeDir,
    });
  }

  rawOn();
}

export function cleanupInterruptedExec(run: InterruptedExec): void {
  const projectRoot = path.resolve(selfDir, '../../../');

  // Clean up CLI-generated setup files before checking for meaningful changes
  try {
    const metaPath = path.join(run.worktreeDir, '.exec-meta.json');
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  } catch {
    /* ignore */
  }
  try {
    execSync(`git -C "${run.worktreeDir}" checkout HEAD -- CLAUDE.md`, { stdio: 'pipe' });
  } catch {
    /* ignore */
  }
  try {
    execSync(`git -C "${run.worktreeDir}" checkout HEAD -- AGENTS.md`, { stdio: 'pipe' });
  } catch {
    /* ignore */
  }

  try {
    const wtStatus = execSync(`git -C "${run.worktreeDir}" status --porcelain`, {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    const wtHead = execSync(`git -C "${run.worktreeDir}" rev-parse HEAD`, {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    const mainHead = execSync(`git rev-parse HEAD`, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();

    if (wtStatus || wtHead !== mainHead) {
      const branchName = `plansync/exec-${run.taskId.slice(0, 8)}-${run.runId.slice(-6)}`;
      if (wtStatus) {
        execSync(`git -C "${run.worktreeDir}" add -A`, { stdio: 'pipe' });
        execSync(
          `git -C "${run.worktreeDir}" commit -m "chore: PlanSync task execution (${run.taskId})"`,
          { stdio: 'pipe' },
        );
      }
      try {
        execSync(`git -C "${run.worktreeDir}" branch "${branchName}"`, { stdio: 'pipe' });
        console.log(`${c.green}✓ Changes saved to branch: ${branchName}${c.reset}`);
      } catch {
        /* branch may already exist */
      }
    }
  } catch {
    /* best-effort */
  }

  try {
    execSync(`git worktree remove --force "${run.worktreeDir}"`, {
      cwd: projectRoot,
      stdio: 'pipe',
    });
  } catch {
    /* ignore */
  }
}

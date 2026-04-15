#!/usr/bin/env node
/**
 * PlanSync Terminal — AI agent backed by PlanSync MCP server
 *
 * Architecture:
 *   User input → RawInput (raw mode) → handleInput()
 *     → AI model (tool_use) → MCP server (stdio) → PlanSync API
 */

import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { cfg, selfDir } from './config.js';
import { c, banner, showSplash } from './ui.js';
import { McpClient } from './mcp-client.js';
import { buildSystemPrompt, runAgentLoop, Message } from './ai-loop.js';
import { fetchStatus, handleSlashCommand, buildPrompt, selectProject } from './commands.js';
import {
  scanInterruptedExecs,
  resumeInterruptedExec,
  cleanupInterruptedExec,
  launchAutoExec,
} from './exec.js';
import { startSession, appendToSession, loadInputHistory } from './session.js';
import { RawInput, SlashCmd } from './input.js';

// ─── Genie settings writer ────────────────────────────────────────────────────

function writeGenieSettings(): void {
  const projectRoot = path.resolve(selfDir, '../../../');
  const settingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
  try {
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      /* ignore */
    }
    existing.mcpServers = {
      plansync: {
        command: path.join(projectRoot, 'bin', 'start-mcp'),
        args: [],
        env: { PLANSYNC_PROJECT: cfg.project || '', LOG_LEVEL: 'warn' },
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
  } catch {
    /* ignore if .claude/ doesn't exist or not writable */
  }
}

// ─── Slash commands registry ──────────────────────────────────────────────────

const SLASH_CMDS: SlashCmd[] = [
  { cmd: '/status', desc: 'Refresh project status' },
  { cmd: '/tasks', desc: 'Show task list' },
  { cmd: '/project', desc: 'Switch project' },
  { cmd: '/resume', desc: 'Restore a previous session' },
  { cmd: '/clear', desc: 'Clear conversation history' },
  { cmd: '/exec', desc: 'Execute a task in Genie' },
  { cmd: '/worker', desc: 'Auto-execute agent tasks (worker mode)' },
  { cmd: '/code', desc: 'Open Genie coding mode' },
  { cmd: '/tools', desc: 'List MCP tools' },
  { cmd: '/help', desc: 'Show help' },
  { cmd: '/quit', desc: 'Exit' },
  // /exit is kept functional but not shown (alias for /quit)
];

// ─── Main REPL ────────────────────────────────────────────────────────────────

async function main() {
  await showSplash();
  writeGenieSettings();

  const interrupted = scanInterruptedExecs();
  const rawInput = new RawInput(SLASH_CMDS);
  const savedHistory = loadInputHistory();

  // ─── Start raw mode first — eliminates readline→rawmode transition issues ──
  rawInput.start(savedHistory);

  // ─── Project selection (via raw mode) ─────────────────────────────────────
  process.stdout.write(`${c.dim}Connecting to PlanSync...${c.reset}\r`);
  if (!cfg.project) {
    try {
      process.stdout.write(' '.repeat(40) + '\r');
      const preAsk = async (prompt: string) => {
        rawInput.setPrompt(prompt);
        return (await rawInput.nextLine()) ?? '';
      };
      await selectProject(preAsk);
    } catch {
      /* ignore */
    }
  }

  // ─── MCP server ───────────────────────────────────────────────────────────
  process.stdout.write(`${c.dim}Starting MCP server...${c.reset}\r`);
  const mcp = new McpClient();
  try {
    await mcp.start(cfg.mcpServer);
    process.stdout.write(' '.repeat(40) + '\r');
  } catch (err: unknown) {
    process.stdout.write(' '.repeat(40) + '\r');
    console.log(
      `${c.yellow}⚠ MCP server failed to start: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
    );
    console.log(
      `  ${c.dim}AI unavailable. /status, /tasks, and other commands still work.${c.reset}\n`,
    );
  }

  // ─── Status + banner ──────────────────────────────────────────────────────
  const status = await fetchStatus();
  process.stdout.write(' '.repeat(40) + '\r');
  banner(status, mcp.getAnthropicTools().length, cfg.user);

  // ─── Session + history ────────────────────────────────────────────────────
  const history: Message[] = [];
  const currentSessionId = startSession(cfg.project);

  let currentStatus = status;
  let currentSystem = buildSystemPrompt(status);

  // ─── MCP notification printer ─────────────────────────────────────────────
  mcp.setNotifyPrinter((text) => {
    rawInput.printAbove(`${c.yellow}[PlanSync] ${text}${c.reset}`);
  });

  // ─── AbortController for in-flight AI requests ───────────────────────────
  let currentAbort: AbortController | null = null;

  // ─── Exit hook ────────────────────────────────────────────────────────────
  rawInput.onSigint = () => {
    rawInput.stop();
    mcp.stop();
    console.log(`\n${c.dim}Goodbye.${c.reset}\n`);
    process.exit(0);
  };

  // ─── ctx for commands ─────────────────────────────────────────────────────
  const ctx = {
    rawInput,
    mcp,
    getStatus: () => currentStatus,
    setStatus: (s: typeof currentStatus) => {
      currentStatus = s;
      currentSystem = buildSystemPrompt(s);
    },
    getSystem: () => currentSystem,
    history,
    currentSessionId,
    // Ask a question using raw mode. setPrompt() renders the question as the prompt string,
    // then nextLine() re-renders it (same content) and waits for Enter.
    // Do NOT call rawInput.pause() here — that would block handleKey and deadlock nextLine().
    ask: async (prompt: string) => {
      rawInput.setPrompt(prompt);
      const answer = (await rawInput.nextLine()) ?? '';
      rawInput.setPrompt(buildPrompt(currentStatus)); // restore normal prompt
      return answer;
    },
  };

  // ─── Resume interrupted executions ───────────────────────────────────────
  for (const run of interrupted) {
    rawInput.clearDisplay();
    console.log(
      `\n${c.yellow}⚠ Interrupted execution found: task ${run.taskId.slice(0, 8)} (run ${run.runId.slice(-6)})${c.reset}`,
    );
    const choice = await ctx.ask(`  Resume? [y]es / [n]o (discard): `);
    if (choice.trim().toLowerCase() === 'y') resumeInterruptedExec(run);
    cleanupInterruptedExec(run);
  }

  // ─── Core input handler ───────────────────────────────────────────────────
  async function handleInput(input: string): Promise<void> {
    if (!input.trim()) return;

    // Shell commands
    if (input.startsWith('!')) {
      const cmd = input.slice(1).trim();
      if (!cmd) return;
      console.log(`\n${c.dim}$ ${cmd}${c.reset}`);
      try {
        const out = execSync(cmd, { encoding: 'utf8', timeout: 15000 }).trim();
        if (out) console.log(out);
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string };
        console.log(`${c.red}${e.stderr?.trim() || e.message}${c.reset}`);
      }
      console.log('');
      return;
    }

    // Bare "/" — show command list
    if (input === '/') {
      console.log('');
      for (const { cmd, desc } of SLASH_CMDS) {
        console.log(`  ${c.cyan}${cmd.padEnd(12)}${c.reset}${c.dim}${desc}${c.reset}`);
      }
      console.log('');
      return;
    }

    // Slash commands
    if (input.startsWith('/')) {
      const result = await handleSlashCommand(input, ctx);
      if (result === 'unknown') {
        console.log(
          `\n${c.yellow}Unknown command: ${input.split(' ')[0]}. Type / to see all commands.${c.reset}\n`,
        );
      }
      return;
    }

    // AI conversation — auto-reconnect MCP if needed
    if (!mcp.isRunning()) {
      process.stdout.write(`${c.dim}Reconnecting MCP...${c.reset}\r`);
      const ok = await mcp.ensureRunning(cfg.mcpServer);
      process.stdout.write(' '.repeat(40) + '\r');
      if (!ok) {
        console.log(`\n${c.yellow}⚠ MCP reconnect failed.${c.reset}\n`);
        return;
      }
      mcp.setNotifyPrinter((text) =>
        rawInput.printAbove(`${c.yellow}[PlanSync] ${text}${c.reset}`),
      );
      console.log(`${c.green}✔ MCP reconnected.${c.reset}`);
    }
    if (mcp.getAnthropicTools().length === 0) {
      console.log(`\n${c.yellow}⚠ MCP connected but no tools available.${c.reset}\n`);
      return;
    }

    currentAbort = new AbortController();

    // Wire Ctrl+C to abort the in-flight AI request
    const origSigint = rawInput.onSigint;
    rawInput.onSigint = () => {
      if (currentAbort) {
        currentAbort.abort();
        currentAbort = null;
        process.stdout.write(`\n${c.yellow}⚠ Cancelled.${c.reset}\n`);
        rawInput.onSigint = origSigint;
      }
    };

    const reply = await runAgentLoop(
      input,
      history,
      currentSystem,
      mcp,
      currentAbort.signal,
      async (taskId, runId, projectId, taskPack) => {
        rawInput.pause();
        const tp = taskPack as { task?: { assigneeType?: string } } | null;
        const isAutonomous = tp?.task?.assigneeType === 'agent';
        await launchAutoExec(taskId, runId, projectId, taskPack, { autonomous: isAutonomous });
        rawInput.resume();
      },
    );

    currentAbort = null;
    rawInput.onSigint = origSigint;

    if (reply) {
      const userMsg: Message = { role: 'user', content: input };
      const assistantMsg: Message = { role: 'assistant', content: reply };
      history.push(userMsg);
      history.push(assistantMsg);
      appendToSession(cfg.project, currentSessionId, userMsg, assistantMsg);
      if (history.length > 40) history.splice(0, history.length - 40);
      currentStatus = await fetchStatus();
      currentSystem = buildSystemPrompt(currentStatus);
    }
  }

  // ─── Main input loop ──────────────────────────────────────────────────────
  while (true) {
    rawInput.setPrompt(buildPrompt(currentStatus));
    const input = await rawInput.nextLine();
    if (input === null) break; // EOF / Ctrl+D
    await handleInput(input);
  }

  rawInput.stop();
  mcp.stop();
  console.log(`\n${c.dim}Goodbye.${c.reset}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(
    `${c.red}Startup failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
  );
  process.exit(1);
});

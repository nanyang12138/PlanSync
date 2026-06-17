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
import { cfg, selfDir } from './config.js';
import { runShellCommand } from './shell-cmd.js';
import { c, banner, showSplash } from './ui.js';
import { McpClient } from './mcp-client.js';
import { ensureMcpBuild } from './mcp-bootstrap.js';
import {
  buildSystemPrompt,
  runAgentLoop,
  pruneHistory,
  formatPruneNotice,
  Message,
} from './ai-loop.js';
import { fetchStatus, handleSlashCommand, buildPrompt, selectProject } from './commands.js';
import {
  scanInterruptedExecs,
  resumeInterruptedExec,
  cleanupInterruptedExec,
  launchAutoExec,
} from './exec.js';
import { startSession, appendToSession, loadInputHistory } from './session.js';
import { InkSession, SlashCmd } from './prompt.js';
import { CliSseListener, describeEvent } from './sse-listener.js';
import { URGENT_EVENTS } from './urgent-events.js';
import { apiEvents, type AuthFailurePayload } from './api-errors.js';

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
  { cmd: '/status', desc: 'Refresh project status', group: 'Project' },
  { cmd: '/tasks', desc: 'Show task list', group: 'Project' },
  { cmd: '/project', desc: 'Switch project', group: 'Project' },
  {
    cmd: '/resync',
    desc: 'Re-sync session (restart MCP, clear drift/abort latch)',
    group: 'Project',
  },
  { cmd: '/exec', desc: 'Execute a task in Genie', group: 'Execution' },
  { cmd: '/worker', desc: 'Auto-execute agent tasks (worker mode)', group: 'Execution' },
  { cmd: '/code', desc: 'Open Genie coding mode', group: 'Execution' },
  { cmd: '/resume', desc: 'Restore a previous session', group: 'Session' },
  { cmd: '/clear', desc: 'Clear conversation history', group: 'Session' },
  { cmd: '/notifs', desc: 'View recent notifications (last 10 min)', group: 'Session' },
  { cmd: '/verbose', desc: 'Toggle verbose tool output (default: off)', group: 'Session' },
  { cmd: '/tools', desc: 'List MCP tools', group: 'Session' },
  { cmd: '/help', desc: 'Show help', group: 'Session' },
  { cmd: '/quit', desc: 'Exit', group: 'Session' },
  // /exit is kept functional but not shown (alias for /quit)
];

// ─── Main REPL ────────────────────────────────────────────────────────────────

async function main() {
  await showSplash();
  writeGenieSettings();

  const interrupted = scanInterruptedExecs();
  const rawInput = new InkSession(SLASH_CMDS);
  const savedHistory = loadInputHistory();

  // ─── Start raw mode first — eliminates readline→rawmode transition issues ──
  rawInput.start(savedHistory);

  // ─── Project selection (via raw mode) ─────────────────────────────────────
  process.stdout.write(`${c.dim}Connecting to PlanSync...${c.reset}\r`);
  if (!cfg.project) {
    try {
      process.stdout.write(' '.repeat(40) + '\r');
      // Ink not yet mounted at startup — rawReadLine uses readline directly
      await selectProject((p) => rawInput.rawReadLine(p));
    } catch {
      /* ignore */
    }
  }

  // ─── MCP server ───────────────────────────────────────────────────────────
  // R-101: build the MCP server dist on demand. Mirrors `bin/start-mcp` so
  // launching the CLI directly on a fresh clone (where dist/ is gitignored)
  // does not crash with "Cannot find module …/dist/index.js".
  process.stdout.write(`${c.dim}Starting MCP server...${c.reset}\r`);
  const mcp = new McpClient();
  try {
    const projectRoot = path.resolve(selfDir, '../../../');
    const buildOutcome = ensureMcpBuild({
      serverPath: cfg.mcpServer,
      projectRoot,
      nodeBin: cfg.nodeBin,
      logger: (msg) => {
        process.stdout.write(' '.repeat(40) + '\r');
        console.log(`${c.dim}${msg}${c.reset}`);
        process.stdout.write(`${c.dim}Starting MCP server...${c.reset}\r`);
      },
    });
    if (!buildOutcome.ok) {
      throw new Error(buildOutcome.error || 'MCP server dist not available');
    }
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
  banner(status, mcp.getAnthropicTools().length, cfg.user, rawInput.getNotifLog());

  // ─── Session + history ────────────────────────────────────────────────────
  const history: Message[] = [];
  const currentSessionId = startSession(cfg.project);

  let currentStatus = status;
  let currentSystem = buildSystemPrompt(status);

  // ─── MCP notification printer + live status refresh ──────────────────────
  // Each MCP notification means an SSE event fired server-side. We use that
  // signal to refresh status and re-render the prompt, so the inline indicators
  // (plan version, drift count, task counts) reflect changes within ~1 s.
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleStatusRefresh = () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      try {
        const fresh = await fetchStatus();
        currentStatus = fresh;
        currentSystem = buildSystemPrompt(fresh);
        rawInput.setPrompt(buildPrompt(fresh));
      } catch {
        /* ignore — keep showing last known status */
      }
    }, 800);
  };

  const installNotifyPrinter = () => {
    mcp.setNotifyPrinter((text) => {
      notify(text, false);
      scheduleStatusRefresh();
    });
  };
  installNotifyPrinter();

  // ─── Notification engine ──────────────────────────────────────────────────
  // All events go to notifLog (visible in banner + /notifs).
  // Urgent events trigger a 30s flash in the Ink prompt area above the input
  // line. The set itself lives in `sse-listener.ts` next to `describeEvent`
  // so the urgency policy stays co-located with event rendering and can be
  // unit-tested without booting the REPL.
  const notify = (msg: string, urgent: boolean) => {
    rawInput.setNotifyLine(msg, urgent);
  };

  // ─── Direct SSE subscription ─────────────────────────────────────────────
  // The MCP server has its own event listener, but its notifications can be
  // delayed or dropped by the MCP transport (logging-capability gating, paused
  // stdin during subprocess spawns, etc). Subscribing to SSE directly from the
  // CLI guarantees the user sees plan/drift updates in real time. We tell the
  // MCP server to skip its listener via PLANSYNC_MCP_DISABLE_SSE so events
  // aren't double-printed.
  // R-025: surface auth failures from psRequest/psPost as a notification so
  // the user sees "please re-login" instead of an apparently empty status
  // banner. Coalesced once per minute to avoid spamming on retry storms.
  let lastAuthFailureNotice = 0;
  apiEvents.on('authFailure', (payload: AuthFailurePayload) => {
    const now = Date.now();
    if (now - lastAuthFailureNotice < 60_000) return;
    lastAuthFailureNotice = now;
    notify(`${c.red}⚠ ${payload.message}${c.reset}`, true);
  });

  const sseListener = new CliSseListener((eventType, data) => {
    const msg = describeEvent(eventType, data);
    if (msg) notify(msg, URGENT_EVENTS.has(eventType));
    // If the server closed the connection because we were too slow to consume
    // events, reconnect immediately (delay=0) rather than waiting for the
    // normal exponential backoff. The server will also publish bus_resync_required
    // (#748) so we get a fresh-state signal on reconnect.
    if (eventType === 'backpressure_disconnect') {
      sseListener.scheduleRestart();
    }
    // If this user was just added to or removed from a project, reconnect SSE
    // so the new subscription set takes effect.
    if (
      (eventType === 'member_added' || eventType === 'member_removed') &&
      (data.name === cfg.user || data.memberName === cfg.user)
    ) {
      sseListener.scheduleRestart();
    }
    scheduleStatusRefresh();
  });
  // R-023: surface SSE auth failures to the user via notify(). The listener
  // already prints a red banner to stderr; the notify call ensures the message
  // also lands in the in-CLI notification area so it isn't lost behind output.
  sseListener.on('authFailure', (payload) => {
    notify(`SSE auth failed (${payload.status}). Run ./bin/plansync to re-authenticate.`, true);
  });
  sseListener.start();

  // ─── AbortController for in-flight AI requests ───────────────────────────
  let currentAbort: AbortController | null = null;

  // R-005: when the MCP server reports the run was forcibly aborted (paused,
  // stale-version, race-lost) flip the in-flight AbortController so the
  // ai-loop exits at the next turn boundary. Without this wire-up the
  // mcp-client's `abortHandler` slot stays unset and the agent keeps looping
  // until SIGINT or until the model decides to stop — defeating the
  // defense-in-depth latch wired up in tools/execution.ts + onRunAborted.
  // The red banner gives the user a clear `EXECUTION_SUPERSEDED`-style
  // signal that the loop ended for a structured reason, not by accident.
  mcp.setAbortHandler((reason) => {
    if (currentAbort) {
      currentAbort.abort();
      currentAbort = null;
    }
    process.stdout.write(
      `\n${c.red}⚠ EXECUTION_SUPERSEDED (${reason.code}): ${reason.message}${c.reset}\n` +
        `${c.dim}Run aborted by PlanSync API; AI loop terminated. ` +
        `Resolve the underlying drift / pause and start a fresh execution.${c.reset}\n`,
    );
  });

  // ─── Exit hook ────────────────────────────────────────────────────────────
  rawInput.onSigint = () => {
    rawInput.stop();
    sseListener.stop();
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
      rawInput.setPrompt(buildPrompt(s));
    },
    getSystem: () => currentSystem,
    history,
    currentSessionId,
    getNotifLog: () => rawInput.getNotifLog(),
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

    // Shell commands (R-064: pause Ink around execSync so subprocess output
    // and the Ink frame don't overwrite each other).
    if (input.startsWith('!')) {
      runShellCommand(input.slice(1), { rawInput });
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
      // Re-check the build in case dist was deleted mid-session or dependencies
      // were updated while the CLI was running (#308 — ensureMcpBuild was only
      // called at startup, so a deleted dist would silently fail to reconnect).
      const rebuildResult = ensureMcpBuild({
        serverPath: cfg.mcpServer,
        projectRoot: path.resolve(selfDir, '../../../'),
        nodeBin: cfg.nodeBin,
      });
      if (!rebuildResult.ok) {
        process.stdout.write(' '.repeat(40) + '\r');
        console.log(`\n${c.yellow}⚠ MCP rebuild failed: ${rebuildResult.error}${c.reset}\n`);
        return;
      }
      const ok = await mcp.ensureRunning(cfg.mcpServer);
      process.stdout.write(' '.repeat(40) + '\r');
      if (!ok) {
        console.log(`\n${c.yellow}⚠ MCP reconnect failed.${c.reset}\n`);
        return;
      }
      installNotifyPrinter();
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

    // Unmount Ink before AI writes to stdout. Ink freezes its last frame (the
    // disabled-state echo) without clearing, so the cursor sits just below it.
    // AI output appears there; nextLine() remounts Ink below all AI content.
    // This avoids the cursor-up(prevHeight)+\x1b[J wipe regardless of Ink height.
    rawInput.handoffToAI();

    // When Ink unmounts it calls stdin.setRawMode(false). In cooked mode Ctrl+C
    // sends SIGINT directly to the process (bypasses Ink's key handler). Register
    // a process-level handler so abort still works while Ink is unmounted.
    const processSigintHandler = () => {
      if (currentAbort) {
        currentAbort.abort();
        currentAbort = null;
        process.stdout.write(`\n${c.yellow}⚠ Cancelled.${c.reset}\n`);
      }
    };
    process.once('SIGINT', processSigintHandler);

    const loopResult = await runAgentLoop(
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

    process.off('SIGINT', processSigintHandler);
    currentAbort = null;
    rawInput.onSigint = origSigint;

    if (loopResult.text) {
      // R-063: persist the complete sequence (user input → assistant text/tool_use →
      // tool_result → ... → final assistant text) instead of just the text reply.
      // Keeping tool_use and tool_result blocks in history lets the model reference
      // earlier tool calls in follow-up questions; storing only the surface text
      // amputates that context.
      const userMsg: Message = { role: 'user', content: input };
      const assistantMsg: Message = { role: 'assistant', content: loopResult.text };
      history.push(...loopResult.newMessages);
      appendToSession(cfg.project, currentSessionId, userMsg, assistantMsg);
      const pruneResult = pruneHistory(history, cfg.maxHistoryTokens);
      if (pruneResult.dropped > 0) {
        console.log(`\n${c.yellow}${formatPruneNotice(pruneResult)}${c.reset}`);
      } else if (pruneResult.tokensAfter > pruneResult.budget) {
        // Over budget but couldn't drop anything (e.g. a single message larger
        // than the budget). Notify so the user knows context is at risk (#733).
        console.log(
          `\n${c.yellow}Context at ${pruneResult.tokensAfter.toLocaleString()} tokens (budget: ${pruneResult.budget.toLocaleString()}) — cannot trim further.${c.reset}`,
        );
      }
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
  sseListener.stop();
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

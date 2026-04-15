import * as https from 'https';
import * as http from 'http';
import { cfg } from './config.js';
import { c, banner, printTasks, printHelp, ProjectStatus, emptyStatus } from './ui.js';
import { McpClient } from './mcp-client.js';
import { RawInput } from './input.js';
import { launchCode, launchExec, launchAutoExec } from './exec.js';

// ─── API helpers ──────────────────────────────────────────────────────────────

export function psRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(cfg.apiUrl + path);
    const mod = url.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'x-user-name': cfg.user,
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Parse error: ${data.slice(0, 100)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('API timeout'));
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

export const apiGet = <T>(path: string) => psRequest<T>('GET', path);

// ─── Status fetcher ───────────────────────────────────────────────────────────

export async function fetchStatus(): Promise<ProjectStatus> {
  if (!cfg.project) return emptyStatus();
  try {
    const [proj, drifts, tasksRes, plansRes] = await Promise.all([
      apiGet<{ data?: Record<string, unknown> }>(`/api/projects/${cfg.project}`),
      apiGet<{ data?: unknown[] }>(`/api/projects/${cfg.project}/drifts?status=open`),
      apiGet<{ data?: unknown[] }>(`/api/projects/${cfg.project}/tasks?pageSize=100`),
      apiGet<{ data?: unknown[] }>(`/api/projects/${cfg.project}/plans`),
    ]);

    const project = (proj.data || {}) as Record<string, unknown>;
    const plans = (plansRes.data || []) as Array<Record<string, unknown>>;
    const plan = plans.find((p) => p.status === 'active') || null;
    const proposed = !plan ? plans.find((p) => p.status === 'proposed') || null : null;

    let proposedReviews: { reviewer: string; status: string }[] = [];
    if (proposed) {
      try {
        const revRes = await apiGet<{ data?: unknown[] }>(
          `/api/projects/${cfg.project}/plans/${proposed.id}/reviews`,
        );
        const rawReviews = (revRes.data || []) as Array<Record<string, unknown>>;
        const reviewMap = new Map<string, string>();
        for (const r of (proposed.requiredReviewers as string[]) || []) reviewMap.set(r, 'pending');
        for (const r of rawReviews) reviewMap.set(r.reviewerName as string, r.status as string);
        proposedReviews = Array.from(reviewMap.entries()).map(([reviewer, status]) => ({
          reviewer,
          status,
        }));
      } catch {
        /* ignore */
      }
    }

    const taskList = (tasksRes.data || []) as Array<Record<string, unknown>>;
    const taskAssigneeMap = new Map<string, string | null>();
    for (const t of taskList) taskAssigneeMap.set(t.id as string, (t.assignee as string) || null);

    return {
      projectId: cfg.project,
      projectName: (project.name as string) || cfg.project,
      activePlan: plan
        ? {
            version: plan.version as number,
            title: plan.title as string,
            goal: ((plan.goal as string) || '').slice(0, 120),
          }
        : null,
      proposedPlan: proposed
        ? {
            version: proposed.version as number,
            title: proposed.title as string,
            reviews: proposedReviews,
          }
        : null,
      tasks: {
        total: taskList.length,
        done: taskList.filter((t) => t.status === 'done').length,
        inProgress: taskList.filter((t) => t.status === 'in_progress').length,
        todo: taskList.filter((t) => t.status === 'todo').length,
        blocked: taskList.filter((t) => t.status === 'blocked').length,
      },
      taskList: taskList.map((t) => ({
        id: t.id as string,
        title: t.title as string,
        status: t.status as string,
        assignee: (t.assignee as string) || null,
        priority: (t.priority as string) || 'p2',
      })),
      driftAlerts: ((drifts.data || []) as Array<Record<string, unknown>>).slice(0, 5).map((d) => ({
        id: d.id as string,
        taskTitle: (d.taskTitle ||
          (d.task as Record<string, unknown>)?.title ||
          d.taskId) as string,
        severity: d.severity as string,
        reason: d.reason as string,
        assignee:
          taskAssigneeMap.get(d.taskId as string) ??
          ((d.task as Record<string, unknown>)?.assignee as string) ??
          null,
      })),
    };
  } catch {
    return { ...emptyStatus(), projectId: cfg.project, projectName: cfg.project };
  }
}

// ─── Project management ───────────────────────────────────────────────────────
// All functions accept `ask: (prompt) => Promise<string>` instead of readline.Interface

type AskFn = (prompt: string) => Promise<string>;

async function createProject(ask: AskFn): Promise<void> {
  const name = await ask(`\n  Project name: `);
  if (!name.trim()) {
    console.log(`  ${c.yellow}Cancelled.${c.reset}`);
    return;
  }
  try {
    const result = await psRequest<{ data?: Record<string, unknown> }>('POST', '/api/projects', {
      name: name.trim(),
    });
    const proj = result.data || (result as Record<string, unknown>);
    cfg.project = proj.id as string;
    console.log(`  ${c.green}✓ Created: ${proj.name}  ${c.dim}${proj.id}${c.reset}`);
  } catch (err: unknown) {
    console.log(
      `  ${c.red}✗ Failed to create project: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
    );
  }
}

async function deleteProject(ask: AskFn, list: Array<Record<string, unknown>>): Promise<void> {
  console.log(`\n  ${c.bold}Which project to delete?${c.reset}\n`);
  list.forEach((p, i) =>
    console.log(`  ${c.cyan}${i + 1}${c.reset}. ${c.bold}${p.name}${c.reset}`),
  );
  const choice = await ask(`\n  Enter number [1-${list.length}] or Enter to cancel: `);
  if (!choice.trim()) {
    console.log(`  ${c.yellow}Cancelled.${c.reset}`);
    return;
  }
  const idx = parseInt(choice.trim(), 10) - 1;
  if (idx < 0 || idx >= list.length) {
    console.log(`  ${c.yellow}Invalid selection.${c.reset}`);
    return;
  }
  const proj = list[idx];
  const confirm = await ask(
    `\n  ${c.red}Delete "${proj.name}" and ALL its data? This is irreversible. [y/n]: ${c.reset}`,
  );
  if (!confirm.trim().match(/^y$/i)) {
    console.log(`  ${c.yellow}Cancelled.${c.reset}`);
    return;
  }
  try {
    await psRequest('DELETE', `/api/projects/${proj.id}`);
    if (cfg.project === proj.id) cfg.project = '';
    console.log(`  ${c.green}✓ Deleted: ${proj.name}${c.reset}`);
  } catch (err: unknown) {
    console.log(
      `  ${c.red}✗ Failed to delete project: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
    );
  }
}

export async function selectProject(ask: AskFn): Promise<void> {
  try {
    const res = await apiGet<{ data?: unknown[] }>('/api/projects');
    const list = (res.data || []) as Array<Record<string, unknown>>;
    if (list.length === 0) {
      console.log(`\n  ${c.yellow}⚠ No projects yet.${c.reset}`);
      const yn = await ask(`  Create a new project? [y/n]: `);
      if (!yn.trim() || yn.trim().toLowerCase() === 'y') await createProject(ask);
      return;
    }
    console.log(`\n  ${c.bold}Select a project:${c.reset}\n`);
    list.forEach((p, i) =>
      console.log(`  ${c.cyan}${i + 1}${c.reset}. ${c.bold}${p.name}${c.reset}`),
    );
    console.log(`  ${c.cyan}n${c.reset}. ${c.dim}Create new project${c.reset}`);
    console.log(`  ${c.cyan}d${c.reset}. ${c.dim}Delete a project${c.reset}`);
    const choice = await ask(`\n  Enter number [1-${list.length}], n, or d: `);
    if (choice.trim().toLowerCase() === 'n') {
      await createProject(ask);
      return;
    }
    if (choice.trim().toLowerCase() === 'd') {
      await deleteProject(ask, list);
      await selectProject(ask);
      return;
    }
    const idx = parseInt(choice.trim(), 10) - 1;
    if (idx >= 0 && idx < list.length) {
      cfg.project = list[idx].id as string;
      console.log(`  ${c.green}✓ Selected: ${list[idx].name}${c.reset}`);
    }
  } catch (err: unknown) {
    console.log(
      `  ${c.red}✗ Failed to fetch projects: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
    );
  }
}

// ─── Command handler ──────────────────────────────────────────────────────────

export interface CommandContext {
  rawInput: RawInput;
  mcp: McpClient;
  getStatus: () => ProjectStatus;
  setStatus: (s: ProjectStatus) => void;
  getSystem: () => string;
  history: import('./ai-loop.js').Message[];
  currentSessionId: string;
  /** Show a prompt and wait for one line of input. */
  ask: (prompt: string) => Promise<string>;
}

export async function handleSlashCommand(
  input: string,
  ctx: CommandContext,
): Promise<'exit' | 'handled' | 'unknown'> {
  const parts = input.split(' ');
  const cmd = parts[0].toLowerCase();

  if (cmd === '/quit' || cmd === '/exit') {
    ctx.mcp.stop();
    ctx.rawInput.stop();
    console.log(`\n${c.dim}Goodbye.${c.reset}\n`);
    process.exit(0);
  }

  if (cmd === '/help') {
    printHelp(ctx.mcp.getAnthropicTools().length);
    return 'handled';
  }

  if (cmd === '/clear') {
    ctx.history.length = 0;
    console.log(`\n${c.dim}Conversation history cleared.${c.reset}\n`);
    return 'handled';
  }

  if (cmd === '/resume') {
    const { listSessions, loadSessionById } = await import('./session.js');
    const targetId = parts[1]?.trim();

    if (ctx.history.length > 0) {
      console.log(
        `\n${c.yellow}Session already active (${ctx.history.length} messages). Use /clear first.${c.reset}\n`,
      );
      return 'handled';
    }

    const sessions = listSessions(cfg.project);
    if (sessions.length === 0) {
      console.log(`\n${c.dim}No previous sessions found for this project.${c.reset}\n`);
      return 'handled';
    }

    let chosenId = targetId;

    // If no ID given, show list and let user pick
    if (!chosenId) {
      const status = ctx.getStatus();
      console.log(`\n  ${c.bold}Recent sessions — ${status.projectName}${c.reset}\n`);
      sessions.slice(0, 10).forEach((s, i) => {
        const dt = new Date(s.startedAt);
        const dateStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
        const msgs = s.messageCount > 0 ? `${Math.floor(s.messageCount / 2)} turns` : 'empty';
        console.log(
          `  ${c.cyan}${i + 1}${c.reset}. ${c.dim}${s.id}${c.reset}  ${dateStr}  ${c.dim}${msgs}${c.reset}`,
        );
      });
      console.log('');

      const choice = await ctx.ask(`  Enter number or session ID (Enter to cancel): `);

      if (!choice.trim()) {
        console.log(`  ${c.dim}Cancelled.${c.reset}\n`);
        return 'handled';
      }

      const num = parseInt(choice.trim(), 10);
      if (!isNaN(num) && num >= 1 && num <= sessions.length) {
        chosenId = sessions[num - 1].id;
      } else {
        chosenId = choice.trim();
      }
    }

    const msgs = loadSessionById(cfg.project, chosenId);
    if (msgs.length === 0) {
      console.log(`\n${c.yellow}Session "${chosenId}" not found or empty.${c.reset}\n`);
      return 'handled';
    }

    ctx.history.push(...msgs);
    const meta = sessions.find((s) => s.id === chosenId);
    const dateStr = meta ? new Date(meta.startedAt).toLocaleString() : '';
    console.log(
      `\n${c.green}✔${c.reset} Resumed session ${c.dim}${chosenId}${c.reset}${dateStr ? ` (${dateStr})` : ''} — ${Math.floor(msgs.length / 2)} turns loaded.\n`,
    );
    return 'handled';
  }

  if (cmd === '/tools') {
    const tools = ctx.mcp.getAnthropicTools();
    if (tools.length === 0) {
      console.log(`\n  ${c.dim}MCP not connected — no tools available.${c.reset}\n`);
    } else {
      console.log(`\n  ${c.bold}Available MCP tools (${tools.length})${c.reset}\n`);
      tools.forEach((t) =>
        console.log(
          `  ${c.violet}${t.name}${c.reset}  ${c.dim}${(t.description || '').slice(0, 70)}${c.reset}`,
        ),
      );
      console.log('');
    }
    return 'handled';
  }

  if (cmd === '/status') {
    process.stdout.write(`${c.dim}Refreshing status...${c.reset}\r`);
    const s = await fetchStatus();
    ctx.setStatus(s);
    process.stdout.write(' '.repeat(40) + '\r');
    banner(s, ctx.mcp.getAnthropicTools().length, cfg.user);
    return 'handled';
  }

  if (cmd === '/tasks') {
    const s = ctx.getStatus();
    if (!s.taskList.length) {
      process.stdout.write(`${c.dim}Fetching tasks...${c.reset}\r`);
      const fresh = await fetchStatus();
      ctx.setStatus(fresh);
      process.stdout.write(' '.repeat(40) + '\r');
      printTasks(fresh);
    } else {
      printTasks(s);
    }
    return 'handled';
  }

  if (cmd === '/project') {
    const targetId = parts[1]?.trim();
    if (targetId) {
      cfg.project = targetId;
    } else {
      // selectProject uses ctx.ask() which uses rawInput in active mode — do NOT pause here
      await selectProject(ctx.ask.bind(ctx));
    }
    if (cfg.project) {
      process.stdout.write(`${c.dim}Restarting MCP (new project)...${c.reset}\r`);
      ctx.mcp.stop();
      try {
        await ctx.mcp.start(cfg.mcpServer);
      } catch {
        /* ignore */
      }
      const s = await fetchStatus();
      ctx.setStatus(s);
      process.stdout.write(' '.repeat(40) + '\r');
      banner(s, ctx.mcp.getAnthropicTools().length, cfg.user);
    }
    return 'handled';
  }

  if (cmd === '/code') {
    ctx.rawInput.pause();
    const codeChild = launchCode();
    const resumeOnExit = () => ctx.rawInput.resume();
    codeChild.on('close', resumeOnExit);
    codeChild.on('error', resumeOnExit); // ensure resume even if Genie fails to start
    return 'handled';
  }

  if (cmd === '/exec') {
    const taskId = parts[1]?.trim();
    if (!taskId) {
      console.log(`\n${c.yellow}Usage: /exec <taskId>${c.reset}\n`);
      return 'handled';
    }
    if (!cfg.project) {
      console.log(
        `\n${c.yellow}No project selected. Use /project to select one first.${c.reset}\n`,
      );
      return 'handled';
    }
    ctx.rawInput.pause();
    await launchExec(taskId, apiGet);
    ctx.rawInput.resume();
    return 'handled';
  }

  if (cmd === '/worker') {
    if (!cfg.project) {
      console.log(
        `\n${c.yellow}No project selected. Use /project to select one first.${c.reset}\n`,
      );
      return 'handled';
    }

    // parts[1] is agent name if non-numeric, otherwise interval
    const isAgentArg = parts[1] !== undefined && isNaN(parseInt(parts[1], 10));
    const agentName: string | undefined = isAgentArg ? parts[1] : undefined;
    const intervalArg = isAgentArg ? parts[2] : parts[1];
    const intervalSec = Math.max(10, parseInt(intervalArg || '60', 10));
    const workerTarget = agentName ?? cfg.user;

    // Preview: fetch pending agent tasks assigned to workerTarget
    let pending: Array<{ id: string; title: string; priority: string }> = [];
    try {
      const res = await apiGet<{ data?: unknown[] }>(
        `/api/projects/${cfg.project}/tasks?assigneeType=agent&assignee=${encodeURIComponent(workerTarget)}&status=todo&pageSize=10`,
      );
      pending = (res.data || []) as Array<{ id: string; title: string; priority: string }>;
    } catch {
      console.log(`\n${c.red}✗ Failed to fetch tasks.${c.reset}\n`);
      return 'handled';
    }

    if (pending.length === 0) {
      console.log(
        `\n${c.dim}No pending agent tasks assigned to ${workerTarget}.${c.reset}\n` +
          `  Assign tasks with assigneeType="agent" and assignee="${workerTarget}" to use worker mode.\n`,
      );
      return 'handled';
    }

    const operatorSuffix = agentName ? `  ${c.dim}[operator: ${cfg.user}]${c.reset}` : '';
    console.log(
      `\n  ${c.bold}PlanSync Worker Mode${c.reset} — Agent tasks assigned to ${workerTarget}:${operatorSuffix}\n`,
    );
    pending.forEach((t, i) =>
      console.log(
        `  ${c.cyan}${i + 1}${c.reset}. ${c.dim}${t.id.slice(0, 8)}${c.reset} [${t.priority}] ${t.title}`,
      ),
    );
    console.log('');
    console.log(`  ${c.dim}[a] all  [1,2,3] specific numbers  [n] cancel${c.reset}`);

    const answer = await ctx.ask(`  Execute: `);
    const trimmed = answer.trim().toLowerCase();

    let selectedIds: string[] = [];
    if (!trimmed || trimmed === 'n') {
      console.log(`  ${c.yellow}Cancelled.${c.reset}\n`);
      return 'handled';
    } else if (trimmed === 'a') {
      selectedIds = pending.map((t) => t.id);
    } else {
      // Parse numbers like "1,2,3" or "1 2 3"
      const nums = trimmed.split(/[\s,]+/).map((s) => parseInt(s, 10) - 1);
      selectedIds = nums.filter((i) => i >= 0 && i < pending.length).map((i) => pending[i].id);
      if (selectedIds.length === 0) {
        console.log(`  ${c.yellow}No valid selection.${c.reset}\n`);
        return 'handled';
      }
    }

    const selectedSet = new Set(selectedIds);

    // Worker loop — pause rawInput so the terminal doesn't accept commands mid-loop
    ctx.rawInput.pause();
    let stopWorker = false;
    const origSigint = ctx.rawInput.onSigint;
    ctx.rawInput.onSigint = () => {
      stopWorker = true;
      console.log(`\n${c.yellow}⚠ Worker stopping after current task...${c.reset}`);
    };

    const taskCount = selectedSet.size;
    console.log(
      `\n${c.green}✓ Worker started${c.reset} — ${taskCount} task(s) selected, polling every ${intervalSec}s ${c.dim}(Ctrl+C to stop)${c.reset}\n`,
    );

    const interruptibleSleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (stopWorker) {
            clearInterval(interval);
            resolve();
          }
        }, 1000);
        setTimeout(() => {
          clearInterval(interval);
          resolve();
        }, ms);
      });

    try {
      while (!stopWorker) {
        // Poll for pending agent tasks
        let tasks: Array<{ id: string; title: string; priority: string }> = [];
        try {
          const res = await apiGet<{ data?: unknown[] }>(
            `/api/projects/${cfg.project}/tasks?assigneeType=agent&assignee=${encodeURIComponent(workerTarget)}&status=todo&pageSize=100`,
          );
          tasks = (res.data || []) as Array<{ id: string; title: string; priority: string }>;
        } catch {
          /* ignore poll errors */
        }

        // Filter to only selected tasks (if user chose specific ones)
        const filtered = tasks.filter((t) => selectedSet.has(t.id));

        for (const task of filtered) {
          if (stopWorker) break;
          console.log(
            `\n${c.blue}[Worker]${c.reset} Executing: ${c.dim}${task.id.slice(0, 8)}${c.reset} "${task.title}"`,
          );

          // Check drift via task pack
          let taskPack: unknown = null;
          try {
            const packResult = await ctx.mcp.callTool('plansync_task_pack', {
              projectId: cfg.project,
              taskId: task.id,
            });
            taskPack = JSON.parse(packResult);
          } catch (err: unknown) {
            console.log(
              `  ${c.red}✗ Task pack failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
            );
            continue;
          }

          const pack = taskPack as { driftAlerts?: Array<{ status: string }> } | null;
          const openDrifts = (pack?.driftAlerts ?? []).filter((d) => d.status === 'open');
          if (openDrifts.length > 0) {
            console.log(
              `  ${c.yellow}⚠ Skipping — ${openDrifts.length} unresolved drift alert(s)${c.reset}`,
            );
            continue;
          }

          // Register execution run
          let runId = '';
          try {
            const startResult = await ctx.mcp.callTool('plansync_execution_start', {
              projectId: cfg.project,
              taskId: task.id,
              executorType: 'agent',
              executorName: workerTarget,
            });
            const parsed = JSON.parse(startResult);
            const run = parsed?.data ?? parsed;
            runId = run?.id ?? '';
          } catch (err: unknown) {
            console.log(
              `  ${c.red}✗ execution_start failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
            );
            continue;
          }

          if (!runId) {
            console.log(`  ${c.red}✗ No run ID in response${c.reset}`);
            continue;
          }

          // Execute autonomously in git worktree sandbox
          await launchAutoExec(task.id, runId, cfg.project, taskPack, { autonomous: true });
          selectedSet.delete(task.id);
          if (selectedSet.size === 0) {
            stopWorker = true;
            console.log(`\n${c.green}✓ All selected tasks completed. Worker stopping.${c.reset}\n`);
            break;
          }
        }

        if (!stopWorker) {
          console.log(`${c.dim}[Worker] Next poll in ${intervalSec}s...${c.reset}`);
          await interruptibleSleep(intervalSec * 1000);
        }
      }
    } finally {
      ctx.rawInput.onSigint = origSigint;
      ctx.rawInput.resume();
      console.log(`\n${c.blue}[Worker] Stopped.${c.reset}\n`);
    }
    return 'handled';
  }

  return 'unknown';
}

// ─── Prompt helpers ───────────────────────────────────────────────────────────

export function buildPrompt(status: ProjectStatus): string {
  const name = status.projectName !== '(no project)' ? status.projectName : '';
  const proj = name.length > 20 ? name.slice(0, 19) + '…' : name;
  const drift =
    status.driftAlerts.length > 0 ? ` ${c.yellow}⚠${status.driftAlerts.length}${c.reset}` : '';
  const label = proj ? `${c.dim}[${c.reset}${proj}${drift}${c.dim}]${c.reset}` : '';
  return `${label}${c.blue}❯${c.reset} `;
}

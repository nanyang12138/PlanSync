#!/usr/bin/env node
/**
 * PlanSync Terminal — AI agent backed by PlanSync MCP server
 *
 * Architecture:
 *   User input → AI model (tool_use) → MCP server (stdio) → PlanSync API
 *
 * The CLI spawns the MCP server as a subprocess, fetches its full tool list,
 * and forwards all AI tool calls to the MCP server via JSON-RPC.
 * This means the CLI always has the full PlanSync tool set without duplicating any logic.
 */

import * as readline from 'readline';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawn, ChildProcess } from 'child_process';

// ─── Config ───────────────────────────────────────────────────────────────────

function parseCustomHeaders(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

const _anthropicBase = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const _anthropicUrl = new URL(_anthropicBase);

// Auto-detect MCP server path: env var, or relative to this file
const _selfDir = path.dirname(process.argv[1] || __filename);
const _mcpAuto = path.resolve(_selfDir, '../../mcp-server/dist/index.js');

const cfg = {
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
};

// ─── Colors ───────────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  violet: '\x1b[35m',
  gray: '\x1b[90m',
};

// ─── PlanSync HTTP helpers (for banner/status display only) ──────────────────

function psRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
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

const apiGet = <T>(path: string) => psRequest<T>('GET', path);

// ─── Project status (for banner display) ─────────────────────────────────────

interface ProjectStatus {
  projectId: string;
  projectName: string;
  activePlan: { version: number; title: string; goal: string } | null;
  proposedPlan: {
    version: number;
    title: string;
    reviews: { reviewer: string; status: string }[];
  } | null;
  tasks: { total: number; done: number; inProgress: number; todo: number; blocked: number };
  taskList: {
    id: string;
    title: string;
    status: string;
    assignee: string | null;
    priority: string;
  }[];
  driftAlerts: {
    id: string;
    taskTitle: string;
    severity: string;
    reason: string;
    assignee: string | null;
  }[];
}

async function fetchStatus(): Promise<ProjectStatus> {
  if (!cfg.project) return emptyStatus();
  try {
    const [proj, drifts, tasksRes, plansRes] = await Promise.all([
      apiGet<any>(`/api/projects/${cfg.project}`),
      apiGet<any>(`/api/projects/${cfg.project}/drifts?status=open`),
      apiGet<any>(`/api/projects/${cfg.project}/tasks?pageSize=100`),
      apiGet<any>(`/api/projects/${cfg.project}/plans`),
    ]);
    const project = proj.data || {};
    const plans: any[] = plansRes.data || [];
    const plan = plans.find((p: any) => p.status === 'active') || null;
    const proposed = !plan ? plans.find((p: any) => p.status === 'proposed') || null : null;

    // Fetch reviews for proposed plan (only when needed)
    let proposedReviews: { reviewer: string; status: string }[] = [];
    if (proposed) {
      try {
        const revRes = await apiGet<any>(
          `/api/projects/${cfg.project}/plans/${proposed.id}/reviews`,
        );
        const rawReviews: any[] = revRes.data || [];
        // Build review status: start with requiredReviewers as pending, overlay actual reviews
        const reviewMap = new Map<string, string>();
        for (const r of proposed.requiredReviewers || []) reviewMap.set(r, 'pending');
        for (const r of rawReviews) reviewMap.set(r.reviewerName, r.status);
        proposedReviews = Array.from(reviewMap.entries()).map(([reviewer, status]) => ({
          reviewer,
          status,
        }));
      } catch {
        /* ignore */
      }
    }

    const taskList: any[] = tasksRes.data || [];
    const taskAssigneeMap = new Map<string, string | null>();
    for (const t of taskList) taskAssigneeMap.set(t.id, t.assignee || null);
    return {
      projectId: cfg.project,
      projectName: project.name || cfg.project,
      activePlan: plan
        ? { version: plan.version, title: plan.title, goal: (plan.goal || '').slice(0, 120) }
        : null,
      proposedPlan: proposed
        ? { version: proposed.version, title: proposed.title, reviews: proposedReviews }
        : null,
      tasks: {
        total: taskList.length,
        done: taskList.filter((t) => t.status === 'done').length,
        inProgress: taskList.filter((t) => t.status === 'in_progress').length,
        todo: taskList.filter((t) => t.status === 'todo').length,
        blocked: taskList.filter((t) => t.status === 'blocked').length,
      },
      taskList: taskList.map((t: any) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        assignee: t.assignee || null,
        priority: t.priority || 'p2',
      })),
      driftAlerts: (drifts.data || []).slice(0, 5).map((d: any) => ({
        id: d.id,
        taskTitle: d.taskTitle || d.task?.title || d.taskId,
        severity: d.severity,
        reason: d.reason,
        assignee: taskAssigneeMap.get(d.taskId) ?? d.task?.assignee ?? null,
      })),
    };
  } catch {
    return { ...emptyStatus(), projectId: cfg.project, projectName: cfg.project };
  }
}

function emptyStatus(): ProjectStatus {
  return {
    projectId: '',
    projectName: '(no project)',
    activePlan: null,
    proposedPlan: null,
    tasks: { total: 0, done: 0, inProgress: 0, todo: 0, blocked: 0 },
    taskList: [],
    driftAlerts: [],
  };
}

// ─── MCP Client ──────────────────────────────────────────────────────────────
// Communicates with the MCP server subprocess via JSON-RPC over stdio.
// This gives the CLI the full PlanSync tool set without duplicating any logic.

class McpClient {
  private proc: ChildProcess | null = null;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private reqId = 0;
  private tools: any[] = [];
  private readBuffer = '';
  private notifyPrinter: ((text: string) => void) | null = null;

  /** Call after readline is ready to get clean notification rendering. */
  setNotifyPrinter(fn: (text: string) => void): void {
    this.notifyPrinter = fn;
  }

  async start(serverPath: string): Promise<void> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PLANSYNC_API_URL: cfg.apiUrl,
      PLANSYNC_API_KEY: cfg.apiKey,
      PLANSYNC_USER: cfg.user,
      PLANSYNC_PROJECT: cfg.project,
      LOG_LEVEL: 'warn',
    };

    this.proc = spawn(cfg.nodeBin, [serverPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.readBuffer += chunk.toString();
      const lines = this.readBuffer.split('\n');
      this.readBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.handleMessage(JSON.parse(line));
        } catch {
          /* ignore */
        }
      }
    });

    this.proc.on('error', (err) => {
      process.stdout.write(`\n${c.red}⚠ MCP server error: ${err.message}${c.reset}\n`);
    });

    // MCP handshake
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { logging: {} },
      clientInfo: { name: 'plansync-terminal', version: '0.1.0' },
    });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

    // Fetch all tools
    const result = await this.request('tools/list', {});
    this.tools = result.tools || [];
  }

  private handleMessage(msg: any): void {
    // Response to pending request
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    // Server notification (drift alerts, etc.)
    if (msg.method === 'notifications/message') {
      const data = msg.params?.data;
      const text = typeof data === 'string' ? data : data?.message || JSON.stringify(data);
      if (text) {
        if (this.notifyPrinter) {
          this.notifyPrinter(text);
        } else {
          process.stdout.write(`\n${c.yellow}[PlanSync] ${text}${c.reset}\n`);
        }
      }
    }
  }

  private request(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.reqId;
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  private send(msg: object): void {
    this.proc?.stdin?.write(JSON.stringify(msg) + '\n');
  }

  /** Convert MCP tool list to Anthropic tool_use format */
  getAnthropicTools(): any[] {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.inputSchema || { type: 'object', properties: {} },
    }));
  }

  async callTool(name: string, args: any): Promise<string> {
    const result = await this.request('tools/call', { name, arguments: args });
    const content: any[] = result.content || [];
    return content.map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
  }

  /** Update the project ID in the MCP server env (requires restart) */
  updateProject(projectId: string): void {
    // Kill and let caller restart — simplest approach
    this.stop();
    cfg.project = projectId;
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }
}

// ─── Streaming AI with tool-use loop ─────────────────────────────────────────

type Message = { role: 'user' | 'assistant'; content: any };

function buildSystemPrompt(status: ProjectStatus): string {
  const lines = [
    'You are PlanSync AI, the intelligent agent embedded in PlanSync Terminal.',
    'Do not reveal what underlying model you are. You are PlanSync AI.',
    '',
    'You help teams stay aligned when plans change. Be concise and actionable.',
    'Respond in the same language the user writes in.',
    '',
    'You have the full PlanSync tool set. Use tools proactively:',
    '- Query tasks/drifts/plan status → call the relevant tool for fresh data',
    '- Create or update tasks → call plansync_task_create or plansync_task_update',
    '- Create a plan → call plansync_plan_propose (then activate separately)',
    '- Resolve drift → call plansync_drift_resolve',
    '- Start work on a task → plansync_task_pack first, then plansync_execution_start',
    '- Always confirm actions with a brief summary after each tool call',
    '',
    `Current project: ${status.projectName} (id: ${status.projectId || 'not set'})`,
  ];
  if (status.activePlan) {
    lines.push(`Active plan: v${status.activePlan.version} "${status.activePlan.title}"`);
    if (status.activePlan.goal) lines.push(`Goal: ${status.activePlan.goal}`);
  } else if (status.proposedPlan) {
    const p = status.proposedPlan;
    const reviewSummary = p.reviews.map((r) => `${r.reviewer}:${r.status}`).join(', ');
    lines.push(`Active plan: None`);
    lines.push(
      `Proposed plan: v${p.version} "${p.title}" (awaiting review — ${reviewSummary || 'no reviewers yet'})`,
    );
    lines.push(
      `Note: to add a reviewer to the proposed plan, call plansync_plan_update with requiredReviewers (list ALL reviewers, including existing ones).`,
    );
  } else {
    lines.push('Active plan: None');
  }
  const t = status.tasks;
  lines.push(
    `Tasks: ${t.total} total — ${t.done} done / ${t.inProgress} in_progress / ${t.todo} todo / ${t.blocked} blocked`,
  );
  if (status.driftAlerts.length > 0) {
    lines.push(`Drift alerts (${status.driftAlerts.length} open):`);
    status.driftAlerts.forEach((d) =>
      lines.push(`  - [${d.severity}] "${d.taskTitle}" (id:${d.id}): ${d.reason}`),
    );
  } else {
    lines.push('Drift alerts: None');
  }
  return lines.join('\n');
}

interface StreamResult {
  text: string;
  toolCalls: { id: string; name: string; input: any }[];
}

async function streamOneTurn(
  messages: Message[],
  system: string,
  tools: any[],
): Promise<StreamResult> {
  if (!cfg.anthropicKey && !cfg.llmKey) {
    console.log(
      `\n${c.yellow}⚠ AI not configured. Set LLM_API_KEY or ANTHROPIC_API_KEY.${c.reset}\n`,
    );
    return { text: '', toolCalls: [] };
  }

  const useAnthropic = !!cfg.anthropicKey;
  const amdUrl = new URL(`${cfg.llmBase}/v1/messages`);
  const hostname = useAnthropic ? cfg.anthropicHostname : amdUrl.hostname;
  const path_ = useAnthropic ? `${cfg.anthropicPathPrefix}/v1/messages` : amdUrl.pathname;

  const requestBody = {
    model: useAnthropic ? cfg.anthropicModel : cfg.llmModel,
    max_tokens: 4096,
    stream: true,
    system,
    tools,
    messages,
  };

  const bodyStr = JSON.stringify(requestBody);
  const headers: Record<string, string> = useAnthropic
    ? {
        'Content-Type': 'application/json',
        'x-api-key': cfg.anthropicKey,
        'anthropic-version': '2023-06-01',
        ...cfg.anthropicCustomHeaders,
      }
    : {
        'Content-Type': 'application/json',
        'x-api-key': 'dummy',
        'anthropic-version': '2023-06-01',
        'Ocp-Apim-Subscription-Key': cfg.llmKey,
      };

  const mod = hostname !== 'localhost' ? https : http;

  return new Promise((resolve) => {
    let buffer = '';
    let textAcc = '';
    let isFirstText = true;
    const prefix = `\n${c.cyan}${c.bold}PlanSync${c.reset} `;

    const toolCalls: { id: string; name: string; input: any }[] = [];
    let currentTool: { id: string; name: string; inputRaw: string } | null = null;

    // Both AMD (/Anthropic/v1/messages) and Anthropic use the same SSE format
    const flush = (line: string) => {
      if (!line.startsWith('data: ')) return;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return;
      let evt: any;
      try {
        evt = JSON.parse(data);
      } catch {
        return;
      }

      const t = evt.type;

      if (t === 'content_block_start') {
        if (evt.content_block?.type === 'tool_use') {
          currentTool = { id: evt.content_block.id, name: evt.content_block.name, inputRaw: '' };
        }
      } else if (t === 'content_block_delta') {
        if (evt.delta?.type === 'text_delta') {
          const text: string = evt.delta.text || '';
          if (text) {
            if (isFirstText) {
              process.stdout.write('\r' + ' '.repeat(30) + '\r' + prefix);
              isFirstText = false;
            }
            process.stdout.write(text);
            textAcc += text;
          }
        } else if (evt.delta?.type === 'input_json_delta' && currentTool) {
          currentTool.inputRaw += evt.delta.partial_json || '';
        }
      } else if (t === 'content_block_stop') {
        if (currentTool) {
          let parsed = {};
          try {
            parsed = JSON.parse(currentTool.inputRaw || '{}');
          } catch {
            /* ignore */
          }
          toolCalls.push({ id: currentTool.id, name: currentTool.name, input: parsed });
          currentTool = null;
        }
      }
    };

    const req = mod.request(
      {
        hostname,
        path: path_,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = '';
          res.on('data', (d: Buffer) => (errBody += d));
          res.on('end', () => {
            process.stdout.write('\r' + ' '.repeat(30) + '\r');
            console.log(
              `\n${c.red}⚠ AI error ${res.statusCode}: ${errBody.slice(0, 200)}${c.reset}\n`,
            );
            resolve({ text: '', toolCalls: [] });
          });
          return;
        }
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          lines.forEach((l) => flush(l.trim()));
        });
        res.on('end', () => {
          if (buffer.trim()) flush(buffer.trim());
          if (textAcc) process.stdout.write('\n\n');
          resolve({ text: textAcc, toolCalls });
        });
      },
    );
    req.on('error', (err) => {
      process.stdout.write('\r' + ' '.repeat(30) + '\r');
      console.log(`\n${c.red}⚠ Network error: ${err.message}${c.reset}\n`);
      resolve({ text: '', toolCalls: [] });
    });
    req.setTimeout(90000, () => {
      req.destroy();
      process.stdout.write('\r' + ' '.repeat(30) + '\r');
      console.log(`\n${c.red}⚠ Request timed out${c.reset}\n`);
      resolve({ text: '', toolCalls: [] });
    });
    req.write(bodyStr);
    req.end();
  });
}

async function runAgentLoop(
  userInput: string,
  history: Message[],
  system: string,
  status: ProjectStatus,
  mcp: McpClient,
): Promise<string> {
  const tools = mcp.getAnthropicTools();
  const messages: Message[] = [...history, { role: 'user', content: userInput }];
  let finalText = '';

  for (let turn = 0; turn < 8; turn++) {
    process.stdout.write(`\n${c.dim}Thinking...${c.reset}`);

    const { text, toolCalls } = await streamOneTurn(messages, system, tools);
    if (text) finalText = text;

    if (toolCalls.length === 0) break;

    const assistantContent: any[] = [];
    if (text) assistantContent.push({ type: 'text', text });
    for (const tc of toolCalls) {
      assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    }
    messages.push({ role: 'assistant', content: assistantContent });

    const toolResults: any[] = [];
    for (const tc of toolCalls) {
      const inputSummary = Object.entries(tc.input || {})
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(', ');
      process.stdout.write(
        `\n${c.dim}  ⚙ ${c.reset}${c.violet}${tc.name}${c.reset}${inputSummary ? ` ${c.dim}{ ${inputSummary} }${c.reset}` : ''}`,
      );

      let result: string;
      try {
        result = await mcp.callTool(tc.name, tc.input);
      } catch (err: any) {
        result = `Tool error: ${err.message}`;
      }

      process.stdout.write(`\r  ${c.green}✓${c.reset} ${c.violet}${tc.name}${c.reset}\n`);
      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return finalText;
}

// ─── Display ─────────────────────────────────────────────────────────────────

function banner(status: ProjectStatus, toolCount: number) {
  const cols = process.stdout.columns || 70;
  const width = Math.min(cols - 2, 70);
  const title = 'PlanSync Terminal';
  const pad = Math.max(0, width - 2 - title.length);

  console.log('');
  console.log(`${c.blue}${c.bold}╔${'═'.repeat(width - 2)}╗${c.reset}`);
  console.log(
    `${c.blue}${c.bold}║${c.reset}${c.bold}${' '.repeat(Math.floor(pad / 2))}${title}${' '.repeat(Math.ceil(pad / 2))}${c.reset}${c.blue}${c.bold}║${c.reset}`,
  );
  console.log(`${c.blue}${c.bold}╚${'═'.repeat(width - 2)}╝${c.reset}`);
  console.log('');

  const REVIEW_ICON: Record<string, string> = {
    approved: `${c.green}✓${c.reset}`,
    rejected: `${c.red}✗${c.reset}`,
    pending: `${c.dim}○${c.reset}`,
  };
  let planStr: string;
  if (status.activePlan) {
    planStr = `v${status.activePlan.version} "${status.activePlan.title}"`;
  } else if (status.proposedPlan) {
    const p = status.proposedPlan;
    const reviewStr =
      p.reviews.length > 0
        ? '  ' +
          p.reviews
            .map((r) => `${c.dim}${r.reviewer}${c.reset} ${REVIEW_ICON[r.status] ?? '○'}`)
            .join('  ')
        : `  ${c.dim}awaiting approval${c.reset}`;
    planStr = `${c.yellow}Pending Review${c.reset}  v${p.version} "${p.title}"${reviewStr}`;
  } else {
    planStr = `${c.dim}(no active plan)${c.reset}`;
  }
  const t = status.tasks;
  const driftStr =
    status.driftAlerts.length > 0
      ? `${c.yellow}⚠ ${status.driftAlerts.length}${c.reset}`
      : `${c.green}✓ none${c.reset}`;

  console.log(
    `  ${c.gray}User${c.reset}    ${c.bold}${cfg.user}${c.reset}   ${c.gray}Project${c.reset}  ${c.cyan}${status.projectName}${c.reset}`,
  );
  console.log(`  ${c.gray}Plan${c.reset}    ${planStr}`);
  if (status.activePlan?.goal) {
    const g = status.activePlan.goal.slice(0, Math.min(cols - 12, 80));
    console.log(`          ${c.dim}${g}${status.activePlan.goal.length > 80 ? '…' : ''}${c.reset}`);
  }
  console.log(
    `  ${c.gray}Tasks${c.reset}   ${t.total} · ${c.green}${t.done} done${c.reset} / ${c.blue}${t.inProgress} in progress${c.reset} / ${t.todo} todo / ${c.yellow}${t.blocked} blocked${c.reset}`,
  );
  console.log(`  ${c.gray}Drift${c.reset}   ${driftStr}`);
  if (status.driftAlerts.length > 0) {
    status.driftAlerts.forEach((d) => {
      let ownerTag: string;
      if (!d.assignee) {
        ownerTag = `  ${c.dim}(unassigned)${c.reset}`;
      } else if (d.assignee === cfg.user) {
        ownerTag = `  ${c.yellow}← yours to resolve${c.reset}`;
      } else {
        ownerTag = `  ${c.dim}→ @${d.assignee}${c.reset}`;
      }
      console.log(`          ${c.yellow}⚠${c.reset} [${d.severity}] "${d.taskTitle}"${ownerTag}`);
    });
  }
  console.log(`  ${c.gray}Tools${c.reset}   ${c.dim}${toolCount} MCP tools${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}Chat with PlanSync AI — it will call tools automatically.${c.reset}`);
  console.log(`  ${c.dim}! runs shell commands  /help for all commands${c.reset}`);
  console.log('');
}

const STATUS_ICON: Record<string, string> = {
  done: `${c.green}✓${c.reset}`,
  in_progress: `${c.blue}▶${c.reset}`,
  todo: '○',
  blocked: `${c.red}✗${c.reset}`,
};

function printTasks(status: ProjectStatus) {
  if (status.taskList.length === 0) {
    console.log(`\n  ${c.dim}No tasks.${c.reset}\n`);
    return;
  }
  console.log(
    `\n  ${c.bold}Tasks — ${status.projectName}${c.reset}  ${c.dim}(${status.taskList.length})${c.reset}\n`,
  );
  const groups: Record<string, typeof status.taskList> = {
    in_progress: [],
    todo: [],
    blocked: [],
    done: [],
  };
  for (const t of status.taskList) (groups[t.status] ??= []).push(t);

  const showGroup = (label: string, items: typeof status.taskList) => {
    if (!items.length) return;
    console.log(`  ${c.gray}── ${label} (${items.length}) ──${c.reset}`);
    items.forEach((t) => {
      const prio =
        t.priority === 'p0'
          ? `${c.red}P0${c.reset}`
          : t.priority === 'p1'
            ? `${c.yellow}P1${c.reset}`
            : `${c.dim}P2${c.reset}`;
      const who = t.assignee ? `  ${c.dim}@${t.assignee}${c.reset}` : '';
      const title = t.title.length > 52 ? t.title.slice(0, 51) + '…' : t.title;
      console.log(`    ${STATUS_ICON[t.status] || '·'} ${title}  ${prio}${who}`);
    });
    console.log('');
  };

  showGroup('In Progress', groups.in_progress);
  showGroup('Todo', groups.todo);
  showGroup('Blocked', groups.blocked);
  showGroup('Done', groups.done);
}

function printHelp(toolCount: number) {
  console.log('');
  console.log(`${c.bold}PlanSync Terminal — Commands${c.reset}`);
  console.log('');
  console.log(`  ${c.cyan}/status${c.reset}              Refresh and show project status`);
  console.log(`  ${c.cyan}/tasks${c.reset}               Show task list`);
  console.log(`  ${c.cyan}/project [id]${c.reset}        Switch project (interactive if no arg)`);
  console.log(`  ${c.cyan}/tools${c.reset}               List all available MCP tools`);
  console.log(
    `  ${c.cyan}/code${c.reset}                Enter Genie coding mode (with PlanSync MCP)`,
  );
  console.log(`  ${c.cyan}/clear${c.reset}               Clear conversation history`);
  console.log(`  ${c.cyan}/quit${c.reset}  ${c.cyan}/exit${c.reset}        Exit`);
  console.log('');
  console.log(`  ${c.dim}! prefix runs shell commands, e.g.: !git log --oneline -5${c.reset}`);
  console.log('');
  console.log(`  ${c.bold}AI uses ${toolCount} MCP tools:${c.reset}`);
  console.log(
    `  ${c.dim}Create/update tasks, view plans, resolve drift, register executions, view team status…${c.reset}`,
  );
  console.log(`  ${c.dim}Just say it in natural language — AI picks the right tool.${c.reset}`);
  console.log('');
}

// ─── /code command ─────────────────────────────────────────────────────────────

function launchCode(): ReturnType<typeof spawn> {
  // Genie reads MCP config from .claude/settings.local.json in the project directory.
  // Temporarily set PLANSYNC_PROJECT so the MCP server knows which project to use.
  const projectRoot = path.resolve(_selfDir, '../../../');
  const settingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
  let originalProject = '';
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.mcpServers?.plansync?.env) {
      originalProject = settings.mcpServers.plansync.env.PLANSYNC_PROJECT || '';
      settings.mcpServers.plansync.env.PLANSYNC_PROJECT = cfg.project;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
  } catch {
    /* ignore */
  }

  console.log(`\n${c.blue}→ Entering PlanSync Coding Mode${c.reset}\n`);
  const child = spawn(cfg.genieOrClaude, [], {
    stdio: 'inherit',
    env: { ...process.env },
    cwd: projectRoot,
  });

  const restore = () => {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings.mcpServers?.plansync?.env) {
        settings.mcpServers.plansync.env.PLANSYNC_PROJECT = originalProject;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      }
    } catch {
      /* ignore */
    }
  };
  child.on('close', () => {
    restore();
    console.log(`\n${c.blue}← Returned to PlanSync Terminal${c.reset}\n`);
  });
  child.on('error', (err) => {
    restore();
    console.log(`\n${c.red}✗ ${err.message}${c.reset}\n`);
  });
  return child;
}

// ─── Project selection ──────────────────────────────────────────────────────

async function createProject(rl: readline.Interface): Promise<void> {
  const name = await new Promise<string>((resolve) => rl.question(`\n  Project name: `, resolve));
  if (!name.trim()) {
    console.log(`  ${c.yellow}Cancelled.${c.reset}`);
    return;
  }
  try {
    const result = await psRequest<any>('POST', '/api/projects', { name: name.trim() });
    const proj = result.data || result;
    cfg.project = proj.id;
    console.log(`  ${c.green}✓ Created: ${proj.name}  ${c.dim}${proj.id}${c.reset}`);
  } catch (err: any) {
    console.log(`  ${c.red}✗ Failed to create project: ${err.message}${c.reset}`);
  }
}

async function deleteProject(rl: readline.Interface, list: any[]): Promise<void> {
  console.log(`\n  ${c.bold}Which project to delete?${c.reset}\n`);
  list.forEach((p: any, i: number) =>
    console.log(`  ${c.cyan}${i + 1}${c.reset}. ${c.bold}${p.name}${c.reset}`),
  );
  const choice = await new Promise<string>((resolve) =>
    rl.question(`\n  Enter number [1-${list.length}] or Enter to cancel: `, resolve),
  );
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
  const confirm = await new Promise<string>((resolve) =>
    rl.question(
      `\n  ${c.red}Delete "${proj.name}" and ALL its data? This is irreversible. [y/n]: ${c.reset}`,
      resolve,
    ),
  );
  if (!confirm.trim().match(/^y$/i)) {
    console.log(`  ${c.yellow}Cancelled.${c.reset}`);
    return;
  }
  try {
    await psRequest<any>('DELETE', `/api/projects/${proj.id}`);
    if (cfg.project === proj.id) cfg.project = '';
    console.log(`  ${c.green}✓ Deleted: ${proj.name}${c.reset}`);
  } catch (err: any) {
    console.log(`  ${c.red}✗ Failed to delete project: ${err.message}${c.reset}`);
  }
}

async function selectProject(rl: readline.Interface): Promise<void> {
  try {
    const res = await apiGet<any>('/api/projects');
    const list: any[] = res.data || [];
    if (list.length === 0) {
      console.log(`\n  ${c.yellow}⚠ No projects yet.${c.reset}`);
      const yn = await new Promise<string>((resolve) =>
        rl.question(`  Create a new project? [y/n]: `, resolve),
      );
      if (!yn.trim() || yn.trim().toLowerCase() === 'y') await createProject(rl);
      return;
    }
    console.log(`\n  ${c.bold}Select a project:${c.reset}\n`);
    list.forEach((p: any, i: number) =>
      console.log(`  ${c.cyan}${i + 1}${c.reset}. ${c.bold}${p.name}${c.reset}`),
    );
    console.log(`  ${c.cyan}n${c.reset}. ${c.dim}Create new project${c.reset}`);
    console.log(`  ${c.cyan}d${c.reset}. ${c.dim}Delete a project${c.reset}`);
    const choice = await new Promise<string>((resolve) =>
      rl.question(`\n  Enter number [1-${list.length}], n, or d: `, resolve),
    );
    if (choice.trim().toLowerCase() === 'n') {
      await createProject(rl);
      return;
    }
    if (choice.trim().toLowerCase() === 'd') {
      await deleteProject(rl, list);
      await selectProject(rl);
      return;
    }
    const idx = parseInt(choice.trim(), 10) - 1;
    if (idx >= 0 && idx < list.length) {
      cfg.project = list[idx].id;
      console.log(`  ${c.green}✓ Selected: ${list[idx].name}${c.reset}`);
    }
  } catch (err: any) {
    console.log(`  ${c.red}✗ Failed to fetch projects: ${err.message}${c.reset}`);
  }
}

// ─── Main REPL ────────────────────────────────────────────────────────────────

function writeGenieSettings(): void {
  // Auto-generate .claude/settings.local.json so any user can run /code without manual setup.
  // This file is in the project directory (shared NFS) — never write user credentials here.
  // Credentials are read per-user from ~/.config/plansync/env by bin/start-mcp.
  const projectRoot = path.resolve(_selfDir, '../../../');
  const settingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
  try {
    let existing: any = {};
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      /* ignore */
    }
    existing.mcpServers = {
      plansync: {
        command: path.join(projectRoot, 'bin', 'start-mcp'),
        args: [],
        env: {
          PLANSYNC_PROJECT: cfg.project || '',
          LOG_LEVEL: 'warn',
        },
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
  } catch {
    /* ignore if .claude/ doesn't exist or not writable */
  }
}

async function main() {
  writeGenieSettings();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.blue}>${c.reset} `,
    historySize: 100,
  });

  // Step 1: Auto project selection
  process.stdout.write(`${c.dim}Connecting to PlanSync...${c.reset}\r`);
  if (!cfg.project) {
    try {
      const res = await apiGet<any>('/api/projects');
      const list: any[] = res.data || [];
      if (list.length === 1) {
        cfg.project = list[0].id;
        process.stdout.write(' '.repeat(40) + '\r');
        console.log(`  ${c.dim}Auto-selected project: ${c.bold}${list[0].name}${c.reset}`);
      } else {
        process.stdout.write(' '.repeat(40) + '\r');
        await selectProject(rl);
      }
    } catch {
      /* ignore */
    }
  }

  // Step 2: Start MCP server
  process.stdout.write(`${c.dim}Starting MCP server...${c.reset}\r`);
  const mcp = new McpClient();
  let mcpOk = false;
  try {
    await mcp.start(cfg.mcpServer);
    mcpOk = true;
    process.stdout.write(' '.repeat(40) + '\r');
    // Connect readline to MCP notification printer so notifications
    // don't collide with the user's current input line.
    mcp.setNotifyPrinter((text) => {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(`${c.yellow}[PlanSync] ${text}${c.reset}\n`);
      // Only re-display the prompt when readline is idle (not during AI streaming).
      // rl.paused is true while runAgentLoop holds the input loop.
      if (!(rl as any).paused) {
        rl.prompt(true);
      }
    });
  } catch (err: any) {
    process.stdout.write(' '.repeat(40) + '\r');
    console.log(`${c.yellow}⚠ MCP server failed to start: ${err.message}${c.reset}`);
    console.log(`  ${c.dim}Path: ${cfg.mcpServer}${c.reset}`);
    console.log(
      `  ${c.dim}AI unavailable. /status, /tasks, and other commands still work.${c.reset}\n`,
    );
  }

  // Step 3: Fetch status and show banner
  const status = await fetchStatus();
  process.stdout.write(' '.repeat(40) + '\r');
  const toolCount = mcp.getAnthropicTools().length;
  banner(status, toolCount);

  const history: Message[] = [];
  let currentStatus = status;
  let currentSystem = buildSystemPrompt(status);

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // ! shell commands
    if (input.startsWith('!')) {
      const cmd = input.slice(1).trim();
      if (!cmd) {
        rl.prompt();
        return;
      }
      console.log(`\n${c.dim}$ ${cmd}${c.reset}`);
      try {
        const out = execSync(cmd, { encoding: 'utf8', timeout: 15000 }).trim();
        if (out) console.log(out);
      } catch (err: any) {
        console.log(`${c.red}${err.stderr?.trim() || err.message}${c.reset}`);
      }
      console.log('');
      rl.prompt();
      return;
    }

    // Slash commands
    if (input.startsWith('/')) {
      const parts = input.split(' ');
      const cmd = parts[0].toLowerCase();

      if (cmd === '/quit' || cmd === '/exit') {
        mcp.stop();
        console.log(`\n${c.dim}Goodbye.${c.reset}\n`);
        rl.close();
        process.exit(0);
      }
      if (cmd === '/help') {
        printHelp(mcp.getAnthropicTools().length);
        rl.prompt();
        return;
      }
      if (cmd === '/clear') {
        history.length = 0;
        console.log(`\n${c.dim}Conversation history cleared.${c.reset}\n`);
        rl.prompt();
        return;
      }
      if (cmd === '/tools') {
        const tools = mcp.getAnthropicTools();
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
        rl.prompt();
        return;
      }
      if (cmd === '/status') {
        process.stdout.write(`${c.dim}Refreshing status...${c.reset}\r`);
        currentStatus = await fetchStatus();
        currentSystem = buildSystemPrompt(currentStatus);
        process.stdout.write(' '.repeat(40) + '\r');
        banner(currentStatus, mcp.getAnthropicTools().length);
        rl.prompt();
        return;
      }
      if (cmd === '/tasks') {
        if (!currentStatus.taskList.length) {
          process.stdout.write(`${c.dim}Fetching tasks...${c.reset}\r`);
          currentStatus = await fetchStatus();
          process.stdout.write(' '.repeat(40) + '\r');
        }
        printTasks(currentStatus);
        rl.prompt();
        return;
      }
      if (cmd === '/project') {
        const targetId = parts[1]?.trim();
        if (targetId) {
          cfg.project = targetId;
        } else {
          rl.pause();
          await selectProject(rl);
          rl.resume();
        }
        if (cfg.project) {
          // Restart MCP with new project
          process.stdout.write(`${c.dim}Restarting MCP (new project)...${c.reset}\r`);
          mcp.stop();
          try {
            await mcp.start(cfg.mcpServer);
          } catch {
            /* ignore */
          }
          currentStatus = await fetchStatus();
          currentSystem = buildSystemPrompt(currentStatus);
          process.stdout.write(' '.repeat(40) + '\r');
          banner(currentStatus, mcp.getAnthropicTools().length);
        }
        rl.prompt();
        return;
      }
      if (cmd === '/code') {
        rl.pause();
        const codeChild = launchCode();
        codeChild.on('close', () => {
          rl.resume();
          rl.prompt();
        });
        return;
      }
      console.log(`\n${c.yellow}Unknown command: ${cmd}. Type /help.${c.reset}\n`);
      rl.prompt();
      return;
    }

    // AI agent conversation
    if (!mcpOk && mcp.getAnthropicTools().length === 0) {
      console.log(
        `\n${c.yellow}⚠ MCP not connected — AI cannot execute operations. Check MCP server.${c.reset}\n`,
      );
      rl.prompt();
      return;
    }

    rl.pause();
    const reply = await runAgentLoop(input, history, currentSystem, currentStatus, mcp);

    if (reply) {
      history.push({ role: 'user', content: input });
      history.push({ role: 'assistant', content: reply });
      if (history.length > 20) history.splice(0, history.length - 20);
      currentStatus = await fetchStatus();
      currentSystem = buildSystemPrompt(currentStatus);
    }

    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    mcp.stop();
    console.log(`\n${c.dim}Goodbye.${c.reset}\n`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`${c.red}Startup failed: ${err.message}${c.reset}`);
  process.exit(1);
});

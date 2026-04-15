import * as https from 'https';
import * as http from 'http';
import { cfg } from './config.js';
import { c, printToolStart, printToolDone, printToolError, ProjectStatus } from './ui.js';
import { McpClient } from './mcp-client.js';

export type Message = { role: 'user' | 'assistant'; content: unknown };

export function buildSystemPrompt(status: ProjectStatus): string {
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
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
}

export async function streamOneTurn(
  messages: Message[],
  system: string,
  tools: unknown[],
  signal?: AbortSignal,
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
    let sseBuffer = '';
    let textAcc = '';
    let isFirstText = true;
    const prefix = `\n${c.cyan}${c.bold}PlanSync${c.reset} `;
    const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];
    let currentTool: { id: string; name: string; inputRaw: string } | null = null;

    const flush = (chunk: string) => {
      // Buffer and process SSE frames delimited by \n\n
      sseBuffer += chunk;
      const frames = sseBuffer.split(/\n\n/);
      sseBuffer = frames.pop() || '';

      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          let evt: {
            type: string;
            content_block?: { type: string; id: string; name: string };
            delta?: { type: string; text?: string; partial_json?: string };
          };
          try {
            evt = JSON.parse(data);
          } catch {
            continue;
          }

          if (evt.type === 'content_block_start') {
            if (evt.content_block?.type === 'tool_use') {
              currentTool = {
                id: evt.content_block.id,
                name: evt.content_block.name,
                inputRaw: '',
              };
            }
          } else if (evt.type === 'content_block_delta') {
            if (evt.delta?.type === 'text_delta' && evt.delta.text) {
              if (isFirstText) {
                process.stdout.write('\r' + ' '.repeat(30) + '\r' + prefix);
                isFirstText = false;
              }
              process.stdout.write(evt.delta.text);
              textAcc += evt.delta.text;
            } else if (evt.delta?.type === 'input_json_delta' && currentTool) {
              currentTool.inputRaw += evt.delta.partial_json || '';
            }
          } else if (evt.type === 'content_block_stop') {
            if (currentTool) {
              let parsed: Record<string, unknown> = {};
              try {
                parsed = JSON.parse(currentTool.inputRaw || '{}');
              } catch {
                /* ignore */
              }
              toolCalls.push({ id: currentTool.id, name: currentTool.name, input: parsed });
              currentTool = null;
            }
          }
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
        res.on('data', (chunk: Buffer) => flush(chunk.toString()));
        res.on('end', () => {
          if (sseBuffer.trim()) flush(sseBuffer + '\n\n');
          if (textAcc) process.stdout.write('\n\n');
          resolve({ text: textAcc, toolCalls });
        });
      },
    );

    // Abort support
    signal?.addEventListener('abort', () => {
      req.destroy();
      process.stdout.write('\r' + ' '.repeat(30) + '\r');
      resolve({ text: textAcc, toolCalls: [] });
    });

    req.on('error', (err) => {
      if (signal?.aborted) return; // already resolved above
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

export async function runAgentLoop(
  userInput: string,
  history: Message[],
  system: string,
  mcp: McpClient,
  signal?: AbortSignal,
  onExecStart?: (
    taskId: string,
    runId: string,
    projectId: string,
    taskPack: unknown,
  ) => Promise<void>,
): Promise<string> {
  const tools = mcp.getAnthropicTools();
  const messages: Message[] = [...history, { role: 'user', content: userInput }];
  let finalText = '';

  for (let turn = 0; turn < 8; turn++) {
    if (signal?.aborted) break;
    process.stdout.write(`\n${c.dim}Thinking...${c.reset}`);

    const { text, toolCalls } = await streamOneTurn(messages, system, tools, signal);
    if (signal?.aborted) break;
    if (text) finalText = text;
    if (toolCalls.length === 0) break;

    const assistantContent: unknown[] = [];
    if (text) assistantContent.push({ type: 'text', text });
    for (const tc of toolCalls) {
      assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    }
    messages.push({ role: 'assistant', content: assistantContent });

    const toolResults: unknown[] = [];
    for (const tc of toolCalls) {
      printToolStart(tc.name, tc.input);
      const t0 = Date.now();
      let result: string;
      try {
        result = await mcp.callTool(tc.name, tc.input);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        printToolError(msg, Date.now() - t0);
        result = `Tool error: ${msg}`;
        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result });
        continue;
      }
      printToolDone(result, Date.now() - t0);

      // Auto-launch Genie when execution_start is called
      if (
        tc.name === 'plansync_execution_start' &&
        onExecStart &&
        !result.startsWith('Tool error')
      ) {
        try {
          const parsed = JSON.parse(result);
          const run = parsed?.data ?? parsed;
          const runId: string = run?.id ?? '';
          const taskPack: unknown = run?.taskPackSnapshot ?? null;
          const projectId: string = (tc.input as Record<string, string>)?.projectId ?? cfg.project;
          const taskId: string = (tc.input as Record<string, string>)?.taskId ?? '';
          if (runId && taskId) {
            result = [
              JSON.stringify({ data: run }, null, 2),
              '',
              '─────────────────────────────────────────',
              `→ Genie coding mode auto-launched for task ${taskId} (Run: ${runId})`,
              '  Genie will handle: plan review, implementation, execution_complete.',
              '  Do NOT attempt further task work in this terminal.',
              '─────────────────────────────────────────',
            ].join('\n');
            await onExecStart(taskId, runId, projectId, taskPack);
            // Genie completed the task — stop the agent loop immediately.
            // Without this return, the AI would continue to the next turn and
            // re-execute the task itself, ignoring the "don't do more work" hint.
            toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result });
            return finalText;
          }
        } catch {
          /* parse failed — let AI handle normally */
        }
      }

      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return finalText;
}

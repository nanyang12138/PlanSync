import * as https from 'https';
import * as http from 'http';
import { cfg } from './config.js';
import {
  c,
  printToolStart,
  printToolDone,
  printToolError,
  createSpinner,
  ProjectStatus,
} from './ui.js';
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
    '- List or describe members → ALWAYS call plansync_member_list for live data, never generate from memory',
    '- Create or update tasks → call plansync_task({action:"create", ...}) or plansync_task({action:"update", ...})',
    '- Create a plan → call plansync_plan_propose (then activate separately)',
    '- Resolve drift → call plansync_drift_resolve',
    '- Start work on a task → plansync_task_pack first, then plansync_run({action:"start", ...})',
    '- Always confirm actions with a brief summary after each tool call',
    '',
    'Large plan edits: when adding more than ~20 items to deliverables / constraints / ' +
      'standards / openQuestions, call the matching incremental tool ' +
      '(plansync_plan_deliverables_append, plansync_plan_constraints_append, ' +
      'plansync_plan_standards_append, plansync_plan_open_questions_append) in batches of ' +
      '20–30 items per call instead of passing the entire array to plansync_plan_update. ' +
      'This avoids hitting the per-response token limit on a single huge tool call.',
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

export interface TruncatedTool {
  name: string;
  partialInput: string;
}

export interface InvalidTool {
  name: string;
  error: string;
  rawSnippet: string;
}

interface StreamResult {
  text: string;
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  stopReason?: string;
  truncatedTool?: TruncatedTool;
  invalidTool?: InvalidTool;
}

export async function streamOneTurn(
  messages: Message[],
  system: string,
  tools: unknown[],
  signal?: AbortSignal,
  onFirstChunk?: () => void,
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
    max_tokens: cfg.maxOutputTokens,
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
    const prefix = `${c.cyan}${c.bold}PlanSync${c.reset} `;
    const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];
    let currentTool: { id: string; name: string; inputRaw: string } | null = null;
    let stopReason: string | undefined;
    let invalidTool: InvalidTool | undefined;

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
            delta?: {
              type?: string;
              text?: string;
              partial_json?: string;
              stop_reason?: string;
            };
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
                onFirstChunk?.();
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
              try {
                const parsed = JSON.parse(currentTool.inputRaw || '{}') as Record<string, unknown>;
                toolCalls.push({ id: currentTool.id, name: currentTool.name, input: parsed });
              } catch (e) {
                // Don't push {} — silently invoking MCP with empty input causes another silent
                // rejection downstream. Surface this to runAgentLoop so it can retry.
                invalidTool = {
                  name: currentTool.name,
                  error: e instanceof Error ? e.message : String(e),
                  rawSnippet: currentTool.inputRaw.slice(0, 300),
                };
              }
              currentTool = null;
            }
          } else if (evt.type === 'message_delta') {
            // Anthropic surfaces stop_reason in message_delta — track it so the caller
            // can detect max_tokens truncation and recover instead of hanging silently.
            if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
          }
        }
      }
    };

    const finalize = (extra?: Partial<StreamResult>): StreamResult => {
      // If the stream ended while a tool_use block was still being filled,
      // it was cut off mid-JSON by max_tokens (or network). The partial call
      // is unusable — surface it so the caller can ask the model to retry.
      let truncatedTool: TruncatedTool | undefined;
      if (currentTool) {
        truncatedTool = { name: currentTool.name, partialInput: currentTool.inputRaw };
        currentTool = null;
      }
      return { text: textAcc, toolCalls, stopReason, truncatedTool, invalidTool, ...extra };
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
          if (textAcc) process.stdout.write('\n');
          resolve(finalize());
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

/**
 * Result of one user turn through the agent loop.
 *
 * - `text` is the final assistant-visible text reply (back-compat with the old
 *   `Promise<string>` return).
 * - `newMessages` is the full list of messages this turn appended to the
 *   conversation, in order: the initial user input, every intermediate
 *   assistant turn (carrying `tool_use` blocks), every `tool_result` user
 *   turn, and the final assistant reply (text-only when no further tools
 *   were called). Callers must push the entire array into their persisted
 *   history so that subsequent turns can reference earlier tool calls and
 *   their results. Storing only the final text (the pre-R-063 behaviour)
 *   throws away the context the model needs to remain coherent across
 *   related questions.
 */
export interface AgentLoopResult {
  text: string;
  newMessages: Message[];
}

/**
 * R-069: User-facing warning emitted when the agent loop exhausts
 * {@link cfg.maxTurns} consecutive tool/text rounds without the model deciding
 * to stop on its own. Without this hint the loop just exits silently, which
 * makes it look as if the agent simply ignored the request.
 *
 * Exposed as a separate function so unit tests can assert on its content
 * without having to spin up a streaming HTTP mock for {@link runAgentLoop}.
 */
export function formatMaxTurnsWarning(maxTurns: number): string {
  return `⚠ 已达最大轮次 (${maxTurns}); 请尝试更具体的请求`;
}

/**
 * Cheap, deterministic token estimator (chars / 4) used by {@link pruneHistory}.
 * Anthropic's exact tokeniser is not exposed to the CLI, but the chars/4 rule
 * is within ~15% for English/Chinese mixed content and is good enough for a
 * budget knob.
 */
export function estimateTokens(content: unknown): number {
  if (content == null) return 0;
  const s = typeof content === 'string' ? content : JSON.stringify(content);
  return Math.ceil(s.length / 4);
}

function isToolResultMessage(m: Message): boolean {
  if (m.role !== 'user' || !Array.isArray(m.content)) return false;
  return m.content.some(
    (block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: string }).type === 'tool_result',
  );
}

function hasToolUseBlock(m: Message): boolean {
  if (m.role !== 'assistant' || !Array.isArray(m.content)) return false;
  return m.content.some(
    (block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: string }).type === 'tool_use',
  );
}

/**
 * Outcome of a {@link pruneHistory} call.
 *
 * R-070 fix step 2: the caller (e.g. the CLI main loop) needs to know
 * whether anything was actually dropped so it can surface a one-line
 * notice to the user. Returning a structured result instead of the
 * old `void` lets `index.ts` emit `formatPruneNotice` only when a
 * trim happened, without re-estimating the history a second time.
 */
export interface PruneResult {
  /** Number of original messages replaced by the summary stub. */
  dropped: number;
  /** Estimated token count before trimming. */
  tokensBefore: number;
  /** Estimated token count after trimming (includes the summary stub). */
  tokensAfter: number;
  /** Budget that was applied — echoed back for logging. */
  budget: number;
}

/**
 * Trim history in-place so its total estimated token budget stays under
 * `maxTokens`. Drops oldest messages first but never splits an
 * `assistant{tool_use}` / `user{tool_result}` pair — leaving an orphan
 * tool_result at the head makes Anthropic reject the request with a 400.
 * When messages are dropped, a single short user-role stub is left at the
 * head so the model knows the conversation was truncated.
 *
 * R-063 introduced the lightweight chars/4 estimator. R-070 wires that
 * estimator into an explicit token-budget knob (`cfg.maxHistoryTokens`,
 * env: `PLANSYNC_MAX_HISTORY_TOKENS`) and surfaces a {@link PruneResult}
 * so the caller can show a user-visible notice when the history is
 * trimmed. A richer LLM-driven summariser is intentionally out of scope.
 */
export function pruneHistory(history: Message[], maxTokens = 80000): PruneResult {
  const empty: PruneResult = { dropped: 0, tokensBefore: 0, tokensAfter: 0, budget: maxTokens };
  if (history.length === 0) return empty;
  let totalTokens = 0;
  for (const m of history) totalTokens += estimateTokens(m.content);
  const tokensBefore = totalTokens;
  if (totalTokens <= maxTokens) {
    return { ...empty, tokensBefore, tokensAfter: totalTokens };
  }

  let dropEnd = 0;
  while (totalTokens > maxTokens && dropEnd < history.length - 1) {
    totalTokens -= estimateTokens(history[dropEnd].content);
    dropEnd++;
    while (dropEnd < history.length && isToolResultMessage(history[dropEnd])) {
      totalTokens -= estimateTokens(history[dropEnd].content);
      dropEnd++;
    }
  }
  while (dropEnd > 0 && dropEnd < history.length && hasToolUseBlock(history[dropEnd - 1])) {
    if (!isToolResultMessage(history[dropEnd])) break;
    dropEnd--;
  }

  if (dropEnd <= 0) {
    return { ...empty, tokensBefore, tokensAfter: tokensBefore };
  }
  const summary: Message = {
    role: 'user',
    content: `[${dropEnd} earlier message(s) truncated for length]`,
  };
  history.splice(0, dropEnd, summary);
  let tokensAfter = 0;
  for (const m of history) tokensAfter += estimateTokens(m.content);
  return { dropped: dropEnd, tokensBefore, tokensAfter, budget: maxTokens };
}

/**
 * R-070: User-visible one-liner emitted by the CLI main loop after the
 * in-memory history exceeded its token budget and was trimmed. Exposed
 * separately from {@link pruneHistory} so it can be unit-tested without
 * having to redirect stdout.
 */
export function formatPruneNotice(result: PruneResult): string {
  return (
    `⚠ 历史已裁剪 ${result.dropped} 条 (≈${result.tokensBefore} → ${result.tokensAfter} tokens, ` +
    `预算 ${result.budget}; 通过 PLANSYNC_MAX_HISTORY_TOKENS 调整)`
  );
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
): Promise<AgentLoopResult> {
  const tools = mcp.getAnthropicTools();
  const userMessage: Message = { role: 'user', content: userInput };
  const messages: Message[] = [...history, userMessage];
  const startIndex = messages.length - 1;
  let finalText = '';

  let turn = 0;
  for (; turn < cfg.maxTurns; turn++) {
    if (signal?.aborted) break;
    process.stdout.write('\n');
    const thinkSp = createSpinner('Thinking');
    thinkSp.start();

    const { text, toolCalls, stopReason, truncatedTool, invalidTool } = await streamOneTurn(
      messages,
      system,
      tools,
      signal,
      () => thinkSp.stop(),
    );
    thinkSp.stop(); // no-op if already cleared by onFirstChunk; clears if model returned tool calls only
    if (signal?.aborted) break;
    if (text) finalText = text;

    // Recovery case A: tool_use was cut mid-stream by max_tokens (or similar).
    // The partial JSON is unusable; retry the whole turn but tell the model to
    // split big array fields across multiple smaller calls.
    if (truncatedTool) {
      console.log(
        `\n${c.yellow}⚠ Tool '${truncatedTool.name}' was truncated mid-stream ` +
          `(${truncatedTool.partialInput.length} bytes). Asking model to retry in chunks.${c.reset}`,
      );
      // Anthropic requires assistant content to be non-empty; use text or a placeholder.
      messages.push({ role: 'assistant', content: text || '(previous attempt was truncated)' });
      messages.push({
        role: 'user',
        content:
          `Your previous \`${truncatedTool.name}\` call was truncated because the response ` +
          `exceeded max_tokens (${cfg.maxOutputTokens}). Please retry, but split large array ` +
          `fields (deliverables, constraints, standards, openQuestions) into multiple smaller ` +
          `tool calls — e.g. use plansync_plan_patch with batches of 20 ` +
          `({op:'append', field, items}) instead of passing the entire array to ` +
          `plansync_plan_update. If plansync_plan_patch is unavailable, call ` +
          `plansync_plan_update once with the first chunk, then again with the next chunk ` +
          `(use changeSummary to track progress).`,
      });
      continue;
    }

    // Recovery case B: model emitted invalid JSON for a tool_use input (rare).
    // Skip the broken call and ask the model to retry.
    if (invalidTool) {
      console.log(
        `\n${c.red}⚠ Tool '${invalidTool.name}' had invalid JSON: ${invalidTool.error}${c.reset}`,
      );
      messages.push({ role: 'assistant', content: text || '(previous attempt had invalid JSON)' });
      messages.push({
        role: 'user',
        content:
          `Your last \`${invalidTool.name}\` call had invalid JSON input ` +
          `(${invalidTool.error}). Please retry the same tool with valid JSON.`,
      });
      continue;
    }

    // Recovery case C: pure text response was cut off by max_tokens with no tool calls.
    // Prefill what we got and ask the model to continue.
    if (stopReason === 'max_tokens' && toolCalls.length === 0 && text) {
      console.log(
        `\n${c.dim}↻ Output truncated at max_tokens (${cfg.maxOutputTokens}); ` +
          `asking model to continue…${c.reset}`,
      );
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: 'Please continue from where you left off.' });
      continue;
    }

    if (toolCalls.length === 0) break;

    const assistantContent: unknown[] = [];
    if (text) assistantContent.push({ type: 'text', text });
    for (const tc of toolCalls) {
      assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    }
    messages.push({ role: 'assistant', content: assistantContent });

    const toolResults: unknown[] = [];
    for (const tc of toolCalls) {
      let toolSp: ReturnType<typeof createSpinner> | null = null;
      if (cfg.verbose) {
        printToolStart(tc.name, tc.input);
      } else {
        toolSp = createSpinner(`${c.violet}${tc.name}${c.reset}`);
        toolSp.start();
      }
      const t0 = Date.now();
      let result: string;
      try {
        result = await mcp.callTool(tc.name, tc.input);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const ms = Date.now() - t0;
        if (toolSp) {
          toolSp.fail(
            `${c.violet}${tc.name}${c.reset}  ${c.dim}${msg.slice(0, 80)}  ${ms}ms${c.reset}`,
          );
          toolSp = null;
        } else {
          process.stdout.write(`\n  ${c.dim}╭─${c.reset} ${c.violet}${tc.name}${c.reset}\n`);
          printToolError(msg, ms);
        }
        result = `Tool error: ${msg}`;
        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result });
        continue;
      }
      const ms = Date.now() - t0;
      if (cfg.verbose) {
        printToolDone(result, ms);
      } else {
        toolSp!.done(`${c.violet}${tc.name}${c.reset}  ${c.dim}${ms}ms${c.reset}`);
        toolSp = null;
      }

      // R-204: auto-launch Genie when an execution-start call is made via
      // either the new `plansync_run({action:"start", ...})` surface or
      // the legacy `plansync_execution_start` alias. The deprecated alias
      // is kept handled for one release so older prompts still work.
      const isExecStartCall =
        tc.name === 'plansync_execution_start' ||
        (tc.name === 'plansync_run' &&
          typeof (tc.input as Record<string, unknown> | undefined)?.action === 'string' &&
          (tc.input as Record<string, string>).action === 'start');
      if (isExecStartCall && onExecStart && !result.startsWith('Tool error')) {
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
            // R-063: Persist the in-progress assistant turn + tool_result so a
            // follow-up question after Genie can still reference the exec_start
            // tool call and its response.
            messages.push({ role: 'user', content: toolResults });
            const newMessagesEarly = messages.slice(startIndex);
            return { text: finalText, newMessages: newMessagesEarly };
          }
        } catch {
          /* parse failed — let AI handle normally */
        }
      }

      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  if (turn >= cfg.maxTurns && !signal?.aborted) {
    console.log(`\n${c.yellow}${formatMaxTurnsWarning(cfg.maxTurns)}${c.reset}`);
  }

  if (finalText) {
    const last = messages[messages.length - 1];
    const lastIsAssistantText =
      last &&
      last.role === 'assistant' &&
      (typeof last.content === 'string'
        ? last.content === finalText
        : Array.isArray(last.content) &&
          last.content.length === 1 &&
          typeof (last.content[0] as { type?: string })?.type === 'string' &&
          (last.content[0] as { type?: string }).type === 'text');
    if (!lastIsAssistantText) {
      messages.push({ role: 'assistant', content: finalText });
    }
  }

  const newMessages = messages.slice(startIndex);
  return { text: finalText, newMessages };
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient, ApiError } from '../api-client';
import { logger } from '../logger';
import { signalRunAborted } from '../abort-signal';
import type { ExecStateManager } from '../exec-state-manager';

type DriftAlert = { id: string; severity: string; reason: string };

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Recognise the API error codes that mean "this run cannot make further
 * progress on the agent's side" and convert them into a process-wide abort
 * signal so the next tool call short-circuits. Distinct from generic
 * heartbeat failures (network glitch, transient 5xx) which we just log.
 */
function detectAbortFromHeartbeat(err: unknown, runId: string, taskId: string): boolean {
  if (!(err instanceof ApiError)) return false;
  const code = (err.details as { code?: string } | undefined)?.code;
  if (code === 'RUN_PAUSED') {
    signalRunAborted({
      code: 'RUN_PAUSED',
      message:
        err.message ||
        'Run paused by drift v2 — a newer plan version superseded this run. Abort and ack-pause.',
      runId,
      taskId,
    });
    return true;
  }
  if (code === 'RUN_STALE_VERSION') {
    const details = err.details as
      | { runBoundPlanVersion?: number; taskBoundPlanVersion?: number }
      | undefined;
    signalRunAborted({
      code: 'RUN_STALE_VERSION',
      message:
        err.message ||
        `Run is stale: bound to plan v${details?.runBoundPlanVersion}, task now v${details?.taskBoundPlanVersion}.`,
      runId,
      taskId,
      runBoundPlanVersion: details?.runBoundPlanVersion,
      taskBoundPlanVersion: details?.taskBoundPlanVersion,
    });
    return true;
  }
  if (code === 'RUN_RACE_LOST') {
    signalRunAborted({
      code: 'RUN_RACE_LOST',
      message: err.message || 'Run state changed concurrently; abort and refetch task pack.',
      runId,
      taskId,
    });
    return true;
  }
  return false;
}

class HeartbeatManager {
  private intervals = new Map<string, ReturnType<typeof setInterval>>();

  start(
    runId: string,
    projectId: string,
    taskId: string,
    api: ApiClient,
    onDrift?: (drifts: DriftAlert[]) => void,
  ): void {
    if (this.intervals.has(runId)) return;
    const id = setInterval(async () => {
      try {
        const response = await api.post<{ data?: { driftAlerts?: DriftAlert[] } }>(
          `/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=heartbeat`,
          {},
        );
        const driftAlerts = response?.data?.driftAlerts;
        if (driftAlerts && driftAlerts.length > 0) {
          // R-206: a 200 heartbeat with non-empty `driftAlerts` means the
          // task was gated AFTER this run was created and the drift-scan
          // snapshot missed it — so auto-pause did not fire and the API
          // still considers the run "running". The job of the heartbeat
          // is to convert that soft signal into a hard stop so the next
          // tool call short-circuits via `tool-wrapper.ts isRunAborted()`
          // instead of running through a stale ai-loop.
          //
          // API-side LOW filter (runs/[runId]/route.ts:135) guarantees
          // anything that reaches this branch is HIGH or MEDIUM and
          // therefore actionable; we do not need to filter here.
          signalRunAborted({
            code: 'RUN_PAUSED',
            message: `Drift detected on task (${driftAlerts.length} alert(s)); stopping execution.`,
            runId,
            taskId,
          });
          this.stop(runId);
          if (onDrift) onDrift(driftAlerts);
          return;
        }
        logger.debug({ runId }, 'Heartbeat sent');
      } catch (err) {
        if (detectAbortFromHeartbeat(err, runId, taskId)) {
          // Run is over for the agent. Stop the interval so we don't keep
          // poking a dead row; the tool wrapper + CLI mcp-client take it
          // from here.
          this.stop(runId);
        } else {
          logger.warn({ err, runId }, 'Heartbeat failed');
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.intervals.set(runId, id);
    logger.info({ runId, intervalMs: HEARTBEAT_INTERVAL_MS }, 'Auto-heartbeat started');
  }

  stop(runId: string): void {
    const id = this.intervals.get(runId);
    if (id !== undefined) {
      clearInterval(id);
      this.intervals.delete(runId);
      logger.info({ runId }, 'Auto-heartbeat stopped');
    }
  }

  stopAll(): void {
    for (const id of this.intervals.values()) clearInterval(id);
    this.intervals.clear();
    logger.info('All heartbeat intervals cleared');
  }
}

export const heartbeatManager = new HeartbeatManager();

/**
 * R-039 — uniform error envelope for execution tool failure paths.
 *
 * R-037 introduced `{ isError: true, content: [{ type: 'text', text:
 * JSON.stringify({ error: { code, message, ... } }) }] }` as the canonical
 * shape for thrown-error translation in `tool-wrapper.ts`. The execution
 * tools, however, *catch* a few `ApiError` codes (DRIFT_UNRESOLVED,
 * COMPLETION_VERIFICATION_FAILED) so they can also bring the heartbeat
 * back online before responding. Those caught branches historically
 * returned plain-text messages or a slightly different JSON shape, which
 * meant MCP clients couldn't reliably switch on `isError` / `error.code`.
 *
 * `buildExecutionErrorEnvelope` makes every caught branch produce the
 * same shape as `buildErrorEnvelope` (R-037) so callers can parse one
 * format regardless of which tool failed.
 */
export interface ExecutionErrorEnvelope {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
}

interface ExecutionErrorPayload {
  code: string;
  message: string;
  status?: number;
  details?: unknown;
  guidance?: string;
  tool?: string;
}

export function buildExecutionErrorEnvelope(
  payload: ExecutionErrorPayload,
): ExecutionErrorEnvelope {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: payload }),
      },
    ],
  };
}

function buildDriftUnresolvedEnvelope(
  err: ApiError,
  toolName: string,
  opts: { extraMessage?: string } = {},
): ExecutionErrorEnvelope {
  const drifts = (err.details as { drifts?: DriftAlert[] })?.drifts ?? [];
  const driftLines = drifts
    .map(
      (d) =>
        `  [${d.severity.toUpperCase()}] ${d.reason}  →  plansync_drift_resolve ${d.id} action=rebind`,
    )
    .join('\n');
  const guidance = [
    '⚠ Execution blocked — unresolved drifts on this task',
    '',
    opts.extraMessage ?? 'Resolve each alert before starting execution:',
    '',
    'Drift alerts:',
    driftLines || '  (see plansync_drift_list for details)',
    '',
    '  plansync_drift_resolve <driftId> action=rebind     → accept new plan, continue',
    '  plansync_drift_resolve <driftId> action=no_impact  → change does not affect this task',
    '  plansync_drift_resolve <driftId> action=cancel     → release the task',
  ].join('\n');
  return buildExecutionErrorEnvelope({
    code: 'DRIFT_UNRESOLVED',
    message: err.message,
    status: err.status,
    details: { drifts },
    guidance,
    tool: toolName,
  });
}

function buildCompletionVerificationFailedEnvelope(
  err: ApiError,
  toolName: string = 'plansync_execution_complete',
): ExecutionErrorEnvelope {
  const d = err.details as
    | {
        score?: number;
        breakdown?: { specificity: number; coherence: number; coverage: number };
        gaps?: string[];
        feedback?: string;
      }
    | undefined;
  const lines = [
    '⚠ COMPLETION_VERIFICATION_FAILED',
    '',
    `Score: ${d?.score ?? '?'}/100 (threshold: 75)`,
    `  Specificity: ${d?.breakdown?.specificity ?? '?'}/35`,
    `  Coherence:   ${d?.breakdown?.coherence ?? '?'}/35`,
    `  Coverage:    ${d?.breakdown?.coverage ?? '?'}/30`,
    '',
    'Gaps:',
    ...(d?.gaps?.map((g) => `  - ${g}`) ?? ['  (none returned)']),
    '',
    `Feedback: ${d?.feedback ?? err.message}`,
    '',
    'To fix: update your deliverablesMet with SPECIFIC claims that describe',
    'HOW the work was done (endpoints, files, test results), then retry.',
    'Vague claims like "all done" or "completed" will be rejected.',
  ];
  return buildExecutionErrorEnvelope({
    code: 'COMPLETION_VERIFICATION_FAILED',
    message: err.message,
    status: err.status,
    details: d,
    guidance: lines.join('\n'),
    tool: toolName,
  });
}

/**
 * Classify an error from `task_pack` as transient (worth retrying) or fatal.
 *
 * Transient: network-level failures (ECONNRESET, ECONNREFUSED, ETIMEDOUT,
 * ENETUNREACH, EAI_AGAIN) and 5xx `ApiError`s — the agent should stay in
 * exec mode and retry. Fatal: 4xx `ApiError`s (auth/missing/bad-request) and
 * anything else — the agent should report up to the owner.
 */
export function isTransientExecContextError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status >= 500;
  }
  const e = err as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const code =
    (typeof e?.code === 'string' && e.code) ||
    (typeof e?.cause?.code === 'string' && e.cause.code) ||
    '';
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENETUNREACH' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_SOCKET'
  );
}

/**
 * R-204 — shared callback factory hoisted out of `registerExecutionTools` so
 * the new `plansync_run` tool (registered in `tools/run.ts`) can reuse the
 * exact same drift-notification side effect as the legacy
 * `plansync_execution_start` alias. Keeping the closure in one place is
 * what guarantees both tool surfaces behave identically on the wire — see
 * `r204-run-tool.test.ts` for the parity assertions.
 */
export function makeDriftCallback(srv: McpServer) {
  return (drifts: DriftAlert[]) => {
    const highCount = drifts.filter((d) => d.severity === 'high').length;
    const lines = drifts
      .map(
        (d) =>
          `  [${d.severity.toUpperCase()}] ${d.reason}  →  plansync_drift_resolve ${d.id} action=rebind`,
      )
      .join('\n');
    const msg =
      `⚠ DRIFT DETECTED: ${drifts.length} alert(s) (${highCount} high). ` +
      `Pause execution immediately and resolve before continuing.\n` +
      lines;
    Promise.resolve()
      .then(() =>
        srv.server.sendLoggingMessage({
          level: 'warning',
          logger: 'plansync',
          data: { message: msg, drifts },
        }),
      )
      .catch((err: unknown) => {
        logger.warn({ err }, 'Failed to send drift notification');
      });
  };
}

/**
 * R-204 — shared internal handlers for the three execution actions.
 *
 * The legacy `plansync_execution_{start,heartbeat,complete}` tools and the
 * new unified `plansync_run(action, ...)` tool both route through these
 * helpers so the wire-level contract is bit-identical regardless of which
 * surface the caller picked. This is the single source of truth for:
 *   - URL routing (`/api/projects/.../tasks/.../runs[/{runId}?action=...]`)
 *   - auto-heartbeat lifecycle (start binds, complete stops, completion
 *     errors keep the heartbeat alive so the agent can retry)
 *   - the DRIFT_UNRESOLVED / COMPLETION_VERIFICATION_FAILED error
 *     envelope shapes
 *
 * The handlers expect their arguments to already be schema-validated.
 */
export interface ExecutionStartArgs {
  projectId: string;
  taskId: string;
  executorType: 'human' | 'agent';
  executorName: string;
}

export interface ExecutionHeartbeatArgs {
  projectId: string;
  taskId: string;
  runId: string;
}

export interface ExecutionCompleteArgs {
  projectId: string;
  taskId: string;
  runId: string;
  status: 'completed' | 'failed';
  outputSummary?: string;
  filesChanged?: string[];
  blockers?: string[];
  driftSignals?: string[];
  branchName?: string;
  deliverablesMet?: string[];
}

export interface ExecutionHandlerContext {
  api: ApiClient;
  onDrift?: (drifts: DriftAlert[]) => void;
  /** Tool name used in error envelopes — `plansync_run` or the legacy alias. */
  toolName: string;
  execStateManager?: ExecStateManager;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export async function handleExecutionStart(
  args: ExecutionStartArgs,
  ctx: ExecutionHandlerContext,
): Promise<ToolResult> {
  const { projectId, taskId, executorType, executorName } = args;
  try {
    const result = await ctx.api.post(`/api/projects/${projectId}/tasks/${taskId}/runs`, {
      taskId,
      executorType,
      executorName,
    });
    const runId = (result as { data?: { id?: string } })?.data?.id;
    if (runId) {
      ctx.execStateManager?.bindRun({ runId, projectId, taskId });
      heartbeatManager.start(runId, projectId, taskId, ctx.api, ctx.onDrift);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    if (err instanceof ApiError && err.code === 'DRIFT_UNRESOLVED') {
      return buildDriftUnresolvedEnvelope(err, ctx.toolName);
    }
    throw err;
  }
}

export async function handleExecutionHeartbeat(
  args: ExecutionHeartbeatArgs,
  ctx: ExecutionHandlerContext,
): Promise<ToolResult> {
  const { projectId, taskId, runId } = args;
  const result = await ctx.api.post(
    `/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=heartbeat`,
    {},
  );
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export async function handleExecutionComplete(
  args: ExecutionCompleteArgs,
  ctx: ExecutionHandlerContext,
): Promise<ToolResult> {
  const { projectId, taskId, runId, ...body } = args;
  heartbeatManager.stop(runId);
  try {
    const result = await ctx.api.post(
      `/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`,
      body,
    );
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    if (err instanceof ApiError && err.code === 'DRIFT_UNRESOLVED') {
      heartbeatManager.start(runId, projectId, taskId, ctx.api, ctx.onDrift);
      return buildDriftUnresolvedEnvelope(err, ctx.toolName, {
        extraMessage:
          'The plan changed while you were executing. Resolve each drift alert before completing:',
      });
    }
    if (
      err instanceof ApiError &&
      err.status === 422 &&
      err.code === 'COMPLETION_VERIFICATION_FAILED'
    ) {
      heartbeatManager.start(runId, projectId, taskId, ctx.api);
      return buildCompletionVerificationFailedEnvelope(err, ctx.toolName);
    }
    throw err;
  }
}

export function registerExecutionTools(
  server: McpServer,
  api: ApiClient,
  execStateManager?: ExecStateManager,
) {
  server.tool(
    'plansync_exec_context',
    'Call this at session start to check if this session was launched for task execution. Returns task context and runId if so — skip normal session start and present your implementation approach immediately.',
    {},
    async () => {
      const runId = process.env.PLANSYNC_EXEC_RUN_ID ?? '';
      const taskId = process.env.PLANSYNC_EXEC_TASK_ID ?? '';
      const projectId = process.env.PLANSYNC_PROJECT ?? '';

      if (!runId || !taskId || !projectId) {
        return { content: [{ type: 'text', text: JSON.stringify({ execMode: false }) }] };
      }

      try {
        const taskPack = await api.get(`/api/projects/${projectId}/tasks/${taskId}/pack`);

        // R-020: do not start the heartbeat when the task has unresolved
        // drift alerts. Starting the heartbeat against a drifted task would
        // either be a no-op (server pauses the run) or worse — it would let
        // the agent believe execution is live and walk into RUN_PAUSED on
        // the next tool call. Surface the drift up front so the agent stops
        // and asks the owner to resolve before any work begins.
        const drifts =
          (taskPack as { data?: { driftAlerts?: DriftAlert[] } } | null | undefined)?.data
            ?.driftAlerts ?? [];

        if (drifts.length === 0) {
          execStateManager?.bindRun({ runId, projectId, taskId });
          heartbeatManager.start(runId, projectId, taskId, api, makeDriftCallback(server));
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ execMode: true, runId, taskId, projectId, taskPack }),
              },
            ],
          };
        }

        const highCount = drifts.filter((d) => d.severity === 'high').length;
        const driftLines = drifts
          .map(
            (d) =>
              `  [${d.severity.toUpperCase()}] ${d.reason}  →  plansync_drift_resolve ${d.id} action=rebind`,
          )
          .join('\n');
        const message = [
          `⚠ DRIFT DETECTED: ${drifts.length} alert(s) (${highCount} high). ` +
            `Pause execution immediately and resolve before continuing.`,
          driftLines,
          '',
          'Heartbeat NOT started — resolve every drift, then call plansync_exec_context again.',
        ].join('\n');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                execMode: true,
                runId,
                taskId,
                projectId,
                taskPack,
                blocked: 'drift_unresolved',
                driftAlerts: drifts,
                message,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        // R-019: env was set, so this session was launched for execution. A
        // failure to load the task pack must NOT silently demote the session
        // to non-exec — that confuses the agent into running the normal
        // session-start banner. Stay in exec mode and tag the error so the
        // agent (and the CLI shell) can decide whether to retry or report up.
        const message = err instanceof Error ? err.message : String(err);
        const transient = isTransientExecContextError(err);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                execMode: true,
                runId,
                taskId,
                projectId,
                error: message,
                transient,
              }),
            },
          ],
        };
      }
    },
  );

  // R-204 — legacy aliases. These three tool names stay registered for one
  // release so any agent prompt that hasn't migrated to `plansync_run(action,
  // ...)` (CLAUDE.md / AGENTS.md / cli ai-loop / third-party MCP clients)
  // keeps working. The handlers delegate to the same `handleExecution*`
  // helpers as `plansync_run`, so wire behaviour is bit-identical across
  // the two surfaces. Each handler also emits a deprecation warning to the
  // server log on every call — ops can grep `R-204 deprecated alias` to
  // identify callers that still need migration before the next release
  // drops the aliases.
  server.tool(
    'plansync_execution_start',
    '[DEPRECATED — use plansync_run({action:"start", ...})] Register your execution. ' +
      'Binds your work to the current plan version so the team can see you are running. ' +
      'Auto-heartbeat every 30s. Will be removed in the next release.',
    {
      projectId: z.string(),
      taskId: z.string(),
      executorType: z.enum(['human', 'agent']),
      executorName: z.string(),
    },
    async (args) => {
      logger.warn(
        { tool: 'plansync_execution_start' },
        'R-204 deprecated alias called — migrate to plansync_run({action:"start", ...})',
      );
      return handleExecutionStart(args, {
        api,
        onDrift: makeDriftCallback(server),
        toolName: 'plansync_execution_start',
        execStateManager,
      });
    },
  );

  server.tool(
    'plansync_execution_heartbeat',
    '[DEPRECATED — use plansync_run({action:"heartbeat", ...})] Manually send a heartbeat for ' +
      'a running execution (auto-heartbeat does this every 30s, but call this if you want to ' +
      'confirm liveness). Will be removed in the next release.',
    {
      projectId: z.string(),
      taskId: z.string(),
      runId: z.string(),
    },
    async (args) => {
      logger.warn(
        { tool: 'plansync_execution_heartbeat' },
        'R-204 deprecated alias called — migrate to plansync_run({action:"heartbeat", ...})',
      );
      return handleExecutionHeartbeat(args, {
        api,
        toolName: 'plansync_execution_heartbeat',
      });
    },
  );

  server.tool(
    'plansync_execution_complete',
    '[DEPRECATED — use plansync_run({action:"complete", ...})] Complete or fail an execution run. ' +
      'When status=completed: (1) deliverablesMet is REQUIRED — list each plan deliverable you met ' +
      '(e.g. ["Implemented login API endpoint", "Added unit tests for auth module"]); ' +
      '(2) for agent executors, AI will verify your evidence (claims, filesChanged, outputSummary) ' +
      'against the task context and return COMPLETION_VERIFICATION_FAILED with a score breakdown ' +
      'if insufficient — improve your list and retry. Will be removed in the next release.',
    {
      projectId: z.string(),
      taskId: z.string(),
      runId: z.string(),
      status: z.enum(['completed', 'failed']),
      outputSummary: z.string().optional(),
      filesChanged: z.array(z.string()).optional(),
      blockers: z.array(z.string()).optional(),
      driftSignals: z.array(z.string()).optional(),
      branchName: z.string().optional().describe('Git branch name where changes were committed.'),
      deliverablesMet: z
        .array(z.string())
        .optional()
        .describe(
          'Required when status=completed. List each plan deliverable and confirm it was met. Will be AI-verified for agent executors.',
        ),
    },
    async (args) => {
      logger.warn(
        { tool: 'plansync_execution_complete' },
        'R-204 deprecated alias called — migrate to plansync_run({action:"complete", ...})',
      );
      return handleExecutionComplete(args, {
        api,
        onDrift: makeDriftCallback(server),
        toolName: 'plansync_execution_complete',
      });
    },
  );
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient, ApiError } from '../api-client';
import { logger } from '../logger';
import { signalRunAborted } from '../abort-signal';

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
        if (driftAlerts && driftAlerts.length > 0 && onDrift) {
          onDrift(driftAlerts);
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

export function registerExecutionTools(server: McpServer, api: ApiClient) {
  function makeDriftCallback(srv: McpServer) {
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
        heartbeatManager.start(runId, projectId, taskId, api, makeDriftCallback(server));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ execMode: true, runId, taskId, projectId, taskPack }),
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

  server.tool(
    'plansync_execution_start',
    'Register your execution. Binds your work to the current plan version so the team can see you are running. Auto-heartbeat every 30s.',
    {
      projectId: z.string(),
      taskId: z.string(),
      executorType: z.enum(['human', 'agent']),
      executorName: z.string(),
    },
    async (args) => {
      const { projectId, ...body } = args;
      try {
        const result = await api.post(`/api/projects/${projectId}/tasks/${args.taskId}/runs`, body);
        const runId = (result as { data?: { id?: string } })?.data?.id;
        if (runId) {
          heartbeatManager.start(runId, projectId, args.taskId, api, makeDriftCallback(server));
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof ApiError && err.code === 'DRIFT_UNRESOLVED') {
          const drifts =
            (err.details as { drifts?: Array<{ id: string; severity: string; reason: string }> })
              ?.drifts ?? [];
          const driftLines = drifts
            .map(
              (d) =>
                `  [${d.severity.toUpperCase()}] ${d.reason}  →  plansync_drift_resolve ${d.id} action=rebind`,
            )
            .join('\n');
          const guidance = [
            '⚠ Execution blocked — unresolved drifts on this task',
            '',
            'Drift alerts:',
            driftLines || '  (see plansync_drift_list for details)',
            '',
            'Resolve each alert before starting execution:',
            '  plansync_drift_resolve <driftId> action=rebind     → accept new plan, continue',
            '  plansync_drift_resolve <driftId> action=no_impact  → change does not affect this task',
            '  plansync_drift_resolve <driftId> action=cancel     → release the task',
          ].join('\n');
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    error: {
                      code: 'DRIFT_UNRESOLVED',
                      message: err.message,
                      details: { drifts },
                      guidance,
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        throw err;
      }
    },
  );

  server.tool(
    'plansync_execution_heartbeat',
    'Manually send a heartbeat for a running execution (auto-heartbeat does this every 30s, but call this if you want to confirm liveness)',
    {
      projectId: z.string(),
      taskId: z.string(),
      runId: z.string(),
    },
    async (args) => {
      const result = await api.post(
        `/api/projects/${args.projectId}/tasks/${args.taskId}/runs/${args.runId}?action=heartbeat`,
        {},
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_execution_complete',
    'Complete or fail an execution run. When status=completed: (1) deliverablesMet is REQUIRED — list each plan deliverable you met (e.g. ["Implemented login API endpoint", "Added unit tests for auth module"]); (2) for agent executors, AI will verify your evidence (claims, filesChanged, outputSummary) against the task context and return COMPLETION_VERIFICATION_FAILED with a score breakdown if insufficient — improve your list and retry.',
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
      const { projectId, taskId, runId, ...body } = args;
      heartbeatManager.stop(runId);
      try {
        const result = await api.post(
          `/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`,
          body,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof ApiError && err.code === 'DRIFT_UNRESOLVED') {
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
            'The plan changed while you were executing. Resolve each drift alert before completing:',
            driftLines || '  (see plansync_drift_list for details)',
            '',
            '  plansync_drift_resolve <driftId> action=rebind     → accept new plan, continue',
            '  plansync_drift_resolve <driftId> action=no_impact  → change does not affect this task',
            '  plansync_drift_resolve <driftId> action=cancel     → release the task',
          ].join('\n');
          // Restart heartbeat while agent resolves drift
          heartbeatManager.start(runId, projectId, taskId, api, makeDriftCallback(server));
          return { content: [{ type: 'text', text: guidance }] };
        }
        if (
          err instanceof ApiError &&
          err.status === 422 &&
          err.code === 'COMPLETION_VERIFICATION_FAILED'
        ) {
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
          // Run is still active — restart heartbeat while agent retries
          heartbeatManager.start(runId, projectId, taskId, api);
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        throw err;
      }
    },
  );
}

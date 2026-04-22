import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient, ApiError } from '../api-client';
import { logger } from '../logger';

const HEARTBEAT_INTERVAL_MS = 30_000;

class HeartbeatManager {
  private intervals = new Map<string, ReturnType<typeof setInterval>>();

  start(runId: string, projectId: string, taskId: string, api: ApiClient): void {
    if (this.intervals.has(runId)) return;
    const id = setInterval(async () => {
      try {
        await api.post(
          `/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=heartbeat`,
          {},
        );
        logger.debug({ runId }, 'Heartbeat sent');
      } catch (err) {
        logger.warn({ err, runId }, 'Heartbeat failed');
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

export function registerExecutionTools(server: McpServer, api: ApiClient) {
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
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ execMode: true, runId, taskId, projectId, taskPack }),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ execMode: false, error: err.message }),
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
          heartbeatManager.start(runId, projectId, args.taskId, api);
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

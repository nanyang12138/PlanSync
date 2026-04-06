import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient } from '../api-client';
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
      const result = await api.post(`/api/projects/${projectId}/tasks/${args.taskId}/runs`, body);
      const runId = (result as { data?: { id?: string } })?.data?.id;
      if (runId) {
        heartbeatManager.start(runId, projectId, args.taskId, api);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
    'Complete or fail an execution run. When status=completed: (1) deliverablesMet is REQUIRED — list each plan deliverable you met (e.g. ["Implemented login API endpoint", "Added unit tests for auth module"]); (2) for agent executors, AI will verify your list against plan deliverables and return COMPLETION_VERIFICATION_FAILED with specific gaps if insufficient — improve your list and retry.',
    {
      projectId: z.string(),
      taskId: z.string(),
      runId: z.string(),
      status: z.enum(['completed', 'failed']),
      outputSummary: z.string().optional(),
      filesChanged: z.array(z.string()).optional(),
      blockers: z.array(z.string()).optional(),
      driftSignals: z.array(z.string()).optional(),
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
      const result = await api.post(
        `/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`,
        body,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}

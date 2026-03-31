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
    'Start an execution run for a task. Automatically sends heartbeats every 30s to keep the run alive.',
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
    'Complete an execution run with results. Stops the auto-heartbeat.',
    {
      projectId: z.string(),
      taskId: z.string(),
      runId: z.string(),
      status: z.enum(['completed', 'failed']),
      outputSummary: z.string().optional(),
      filesChanged: z.array(z.string()).optional(),
      blockers: z.array(z.string()).optional(),
      driftSignals: z.array(z.string()).optional(),
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

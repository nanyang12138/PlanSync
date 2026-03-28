import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient } from '../api-client';

export function registerExecutionTools(server: McpServer, api: ApiClient) {
  server.tool(
    'plansync_execution_start',
    'Start an execution run for a task (creates a context snapshot)',
    {
      projectId: z.string(),
      taskId: z.string(),
      executorType: z.enum(['human', 'agent']),
      executorName: z.string(),
    },
    async (args) => {
      const { projectId, ...body } = args;
      const result = await api.post(`/api/projects/${projectId}/tasks/${args.taskId}/runs`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_execution_complete',
    'Complete an execution run with results',
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
      const result = await api.post(
        `/api/projects/${projectId}/tasks/${taskId}/runs/${runId}?action=complete`,
        body,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}

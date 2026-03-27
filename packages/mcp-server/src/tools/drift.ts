import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient } from '../api-client';

export function registerDriftTools(server: McpServer, api: ApiClient) {
  server.tool(
    'plansync_drift_list',
    'List drift alerts for a project. Shows tasks that are out of sync with the active plan.',
    {
      projectId: z.string(),
      status: z.enum(['open', 'resolved']).optional().describe('Filter by status, default: all'),
    },
    async (args) => {
      const params = new URLSearchParams();
      if (args.status) params.set('status', args.status);
      const qs = params.toString();
      const result = await api.get(`/api/projects/${args.projectId}/drifts${qs ? `?${qs}` : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}

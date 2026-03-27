import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient } from '../api-client';

export function registerStatusTools(server: McpServer, api: ApiClient) {
  server.tool(
    'plansync_status',
    'Get comprehensive project status: active plan, task counts, open drifts',
    { projectId: z.string() },
    async (args) => {
      const [project, drifts, activities] = await Promise.all([
        api.get<{ data: Record<string, unknown> }>(`/api/projects/${args.projectId}`),
        api.get<{ data: unknown[] }>(`/api/projects/${args.projectId}/drifts?status=open`),
        api.get<{ data: unknown[] }>(`/api/projects/${args.projectId}/activities?pageSize=5`),
      ]);

      const status = {
        project: project.data,
        openDriftAlerts: (drifts.data || []).length,
        driftAlerts: drifts.data,
        recentActivities: activities.data,
      };

      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    },
  );

  server.tool(
    'plansync_activity_list',
    'List recent project activities',
    {
      projectId: z.string(),
      page: z.number().optional(),
      pageSize: z.number().optional(),
    },
    async (args) => {
      const params = new URLSearchParams();
      if (args.page) params.set('page', String(args.page));
      if (args.pageSize) params.set('pageSize', String(args.pageSize));
      const qs = params.toString();
      const result = await api.get(`/api/projects/${args.projectId}/activities${qs ? `?${qs}` : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_task_rebind',
    'Rebind a task to the current active plan version',
    { projectId: z.string(), taskId: z.string() },
    async (args) => {
      const result = await api.post(`/api/projects/${args.projectId}/tasks/${args.taskId}/rebind`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_drift_resolve',
    'Resolve a drift alert (owner only)',
    {
      projectId: z.string(),
      driftId: z.string(),
      action: z.enum(['rebind', 'cancel', 'no_impact']).describe('rebind: update task to new plan, cancel: cancel the task, no_impact: mark as non-issue'),
    },
    async (args) => {
      const result = await api.post(`/api/projects/${args.projectId}/drifts/${args.driftId}`, {
        action: args.action,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}

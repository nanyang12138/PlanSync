import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient } from '../api-client';

export function registerTaskTools(server: McpServer, api: ApiClient) {
  server.tool(
    'plansync_task_list',
    'List tasks for a project with optional filters',
    {
      projectId: z.string(),
      status: z.string().optional().describe('Filter by status: todo, in_progress, blocked, done, cancelled'),
      assignee: z.string().optional().describe('Filter by assignee name'),
      page: z.number().optional(),
      pageSize: z.number().optional(),
    },
    async (args) => {
      const params = new URLSearchParams();
      if (args.status) params.set('status', args.status);
      if (args.assignee) params.set('assignee', args.assignee);
      if (args.page) params.set('page', String(args.page));
      if (args.pageSize) params.set('pageSize', String(args.pageSize));
      const qs = params.toString();
      const result = await api.get(`/api/projects/${args.projectId}/tasks${qs ? `?${qs}` : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_task_show',
    'Get task details including recent execution runs',
    { projectId: z.string(), taskId: z.string() },
    async (args) => {
      const result = await api.get(`/api/projects/${args.projectId}/tasks/${args.taskId}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_task_create',
    'Create a new task (auto-binds to active plan version)',
    {
      projectId: z.string(),
      title: z.string(),
      description: z.string().optional(),
      type: z.enum(['code', 'research', 'design', 'bug', 'refactor']),
      priority: z.enum(['p0', 'p1', 'p2']).optional(),
      assignee: z.string().optional(),
      assigneeType: z.enum(['human', 'agent', 'unassigned']).optional(),
      agentContext: z.string().optional(),
      expectedOutput: z.string().optional(),
      agentConstraints: z.array(z.string()).optional(),
    },
    async (args) => {
      const { projectId, ...body } = args;
      const result = await api.post(`/api/projects/${projectId}/tasks`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_task_update',
    'Update a task',
    {
      projectId: z.string(),
      taskId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']).optional(),
      priority: z.enum(['p0', 'p1', 'p2']).optional(),
    },
    async (args) => {
      const { projectId, taskId, ...body } = args;
      const result = await api.patch(`/api/projects/${projectId}/tasks/${taskId}`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_task_claim',
    'Claim an unassigned task',
    {
      projectId: z.string(),
      taskId: z.string(),
      assigneeType: z.enum(['human', 'agent']).optional(),
    },
    async (args) => {
      const result = await api.post(
        `/api/projects/${args.projectId}/tasks/${args.taskId}/claim`,
        { assigneeType: args.assigneeType || 'agent' },
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_task_pack',
    'Get full task context pack (plan + project + drift alerts) for execution',
    { projectId: z.string(), taskId: z.string() },
    async (args) => {
      const result = await api.get(`/api/projects/${args.projectId}/tasks/${args.taskId}/pack`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}

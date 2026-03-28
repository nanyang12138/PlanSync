import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient } from '../api-client';

let activeProjectId: string | undefined;

export function getActiveProjectId(): string | undefined {
  return activeProjectId;
}

export function registerProjectTools(server: McpServer, api: ApiClient) {
  server.tool(
    'plansync_project_list',
    'List all projects the user has access to',
    { page: z.number().optional(), pageSize: z.number().optional() },
    async (args) => {
      const params = new URLSearchParams();
      if (args.page) params.set('page', String(args.page));
      if (args.pageSize) params.set('pageSize', String(args.pageSize));
      const qs = params.toString();
      const result = await api.get(`/api/projects${qs ? `?${qs}` : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_project_create',
    'Create a new project',
    {
      name: z.string().describe('Project name'),
      description: z.string().optional().describe('Project description'),
      phase: z.enum(['planning', 'active', 'completed']).optional(),
    },
    async (args) => {
      const result = await api.post('/api/projects', args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_project_show',
    'Get project details with status aggregation',
    { projectId: z.string().describe('Project ID') },
    async (args) => {
      const result = await api.get(`/api/projects/${args.projectId}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_project_switch',
    'Switch the active project context (local MCP state only, no API call)',
    {
      projectId: z.string().describe('Project ID to switch to'),
    },
    async (args) => {
      activeProjectId = args.projectId;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ switched: true, activeProjectId: args.projectId }),
          },
        ],
      };
    },
  );

  server.tool(
    'plansync_project_update',
    'Update project details',
    {
      projectId: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      phase: z.enum(['planning', 'active', 'completed']).optional(),
    },
    async (args) => {
      const { projectId, ...body } = args;
      const result = await api.patch(`/api/projects/${projectId}`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}

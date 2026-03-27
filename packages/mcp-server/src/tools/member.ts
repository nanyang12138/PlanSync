import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient } from '../api-client';

export function registerMemberTools(server: McpServer, api: ApiClient) {
  server.tool(
    'plansync_member_list',
    'List all members of a project',
    { projectId: z.string() },
    async (args) => {
      const result = await api.get(`/api/projects/${args.projectId}/members`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_member_add',
    'Add a new member to a project (owner only)',
    {
      projectId: z.string(),
      name: z.string().describe('Member username'),
      role: z.enum(['owner', 'developer']),
      type: z.enum(['human', 'agent']).optional(),
    },
    async (args) => {
      const { projectId, ...body } = args;
      const result = await api.post(`/api/projects/${projectId}/members`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_member_update',
    'Update a member role/type',
    {
      projectId: z.string(),
      memberId: z.string(),
      role: z.enum(['owner', 'developer']).optional(),
      type: z.enum(['human', 'agent']).optional(),
    },
    async (args) => {
      const { projectId, memberId, ...body } = args;
      const result = await api.patch(`/api/projects/${projectId}/members/${memberId}`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_member_remove',
    'Remove a member from a project (owner only)',
    { projectId: z.string(), memberId: z.string() },
    async (args) => {
      const result = await api.delete(`/api/projects/${args.projectId}/members/${args.memberId}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}

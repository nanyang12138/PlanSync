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
    'Update a member role/type by name (owner only)',
    {
      projectId: z.string(),
      name: z.string().describe('Member username'),
      role: z.enum(['owner', 'developer']).optional(),
      type: z.enum(['human', 'agent']).optional(),
    },
    async (args) => {
      const { projectId, name, ...body } = args;
      const members = await api.get<{ data: Array<{ id: string; name: string }> }>(
        `/api/projects/${projectId}/members`,
      );
      const member = members.data.find((m) => m.name === name);
      if (!member) throw new Error(`Member "${name}" not found in project`);
      const result = await api.patch(`/api/projects/${projectId}/members/${member.id}`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_member_remove',
    'Remove a member from a project by name (owner only)',
    { projectId: z.string(), name: z.string().describe('Member username') },
    async (args) => {
      const members = await api.get<{ data: Array<{ id: string; name: string }> }>(
        `/api/projects/${args.projectId}/members`,
      );
      const member = members.data.find((m) => m.name === args.name);
      if (!member) throw new Error(`Member "${args.name}" not found in project`);
      const result = await api.delete(`/api/projects/${args.projectId}/members/${member.id}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient } from '../api-client';

export function registerCommentTools(server: McpServer, api: ApiClient) {
  server.tool(
    'plansync_comment_list',
    'List comments on a plan',
    { projectId: z.string(), planId: z.string() },
    async (args) => {
      const result = await api.get(`/api/projects/${args.projectId}/plans/${args.planId}/comments`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_comment_create',
    'Add a comment to a plan discussion',
    {
      projectId: z.string(),
      planId: z.string(),
      content: z.string().describe('Comment content in Markdown'),
      parentId: z.string().optional().describe('Reply to a specific comment'),
    },
    async (args) => {
      const { projectId, planId, ...body } = args;
      const result = await api.post(`/api/projects/${projectId}/plans/${planId}/comments`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_comment_edit',
    'Edit your own comment',
    {
      projectId: z.string(),
      planId: z.string(),
      commentId: z.string(),
      content: z.string(),
    },
    async (args) => {
      const result = await api.patch(
        `/api/projects/${args.projectId}/plans/${args.planId}/comments/${args.commentId}`,
        { content: args.content },
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_comment_delete',
    'Soft-delete your own comment',
    { projectId: z.string(), planId: z.string(), commentId: z.string() },
    async (args) => {
      const result = await api.delete(
        `/api/projects/${args.projectId}/plans/${args.planId}/comments/${args.commentId}`,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}

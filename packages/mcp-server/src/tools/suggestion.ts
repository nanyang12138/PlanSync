import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient } from '../api-client';

export function registerSuggestionTools(server: McpServer, api: ApiClient) {
  server.tool(
    'plansync_plan_suggest',
    'Formally propose a plan change. Use this instead of mentioning issues verbally — Owner receives a notification and decides. Any member can suggest.',
    {
      projectId: z.string(),
      planId: z.string(),
      field: z.enum(['goal', 'scope', 'constraints', 'standards', 'deliverables', 'openQuestions']),
      action: z
        .enum(['set', 'append', 'remove'])
        .describe('set: replace field value, append: add to array, remove: remove from array'),
      value: z.string().describe('The suggested content'),
      reason: z.string().describe('Why this change is needed'),
      // R-155: optional pointer at a specific PlanDeliverable row this
      // suggestion targets. Lets an agent propose "change refUri on
      // auth/oidc-callback" without rewriting the whole deliverables array.
      // The API verifies the deliverable belongs to the same plan; omit it
      // and the suggestion behaves exactly as before (field-level patch).
      deliverableId: z
        .string()
        .optional()
        .describe(
          'Optional PlanDeliverable row id to scope the suggestion to a single deliverable. ' +
            'Use plansync_deliverable_list to discover ids. Validated server-side.',
        ),
    },
    async (args) => {
      const { projectId, planId, ...body } = args;
      const result = await api.post(`/api/projects/${projectId}/plans/${planId}/suggestions`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_suggestion_list',
    'List suggestions for a plan',
    { projectId: z.string(), planId: z.string() },
    async (args) => {
      const result = await api.get(
        `/api/projects/${args.projectId}/plans/${args.planId}/suggestions`,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_suggestion_resolve',
    'Accept or reject a suggestion (owner only)',
    {
      projectId: z.string(),
      planId: z.string(),
      suggestionId: z.string(),
      action: z.enum(['accept', 'reject']),
      comment: z.string().optional(),
    },
    async (args) => {
      const params = new URLSearchParams({ action: args.action });
      const result = await api.post(
        `/api/projects/${args.projectId}/plans/${args.planId}/suggestions/${args.suggestionId}?${params}`,
        { comment: args.comment },
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}

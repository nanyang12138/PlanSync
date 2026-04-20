import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient } from '../api-client';
import { McpConfig } from '../config';
import { getDelegationAgent } from './status';

export function registerPlanTools(server: McpServer, api: ApiClient, config: McpConfig) {
  server.tool(
    'plansync_plan_list',
    'List all plans for a project',
    { projectId: z.string(), page: z.number().optional(), pageSize: z.number().optional() },
    async (args) => {
      const params = new URLSearchParams();
      if (args.page) params.set('page', String(args.page));
      if (args.pageSize) params.set('pageSize', String(args.pageSize));
      const qs = params.toString();
      const result = await api.get(`/api/projects/${args.projectId}/plans${qs ? `?${qs}` : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_show',
    'Get plan details by ID. Note: if you have a version number, use plansync_plan_list to find the planId first.',
    { projectId: z.string(), planId: z.string().describe('Plan ID (not version number)') },
    async (args) => {
      const result = await api.get(`/api/projects/${args.projectId}/plans/${args.planId}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_active',
    'Get the currently active plan for a project',
    { projectId: z.string() },
    async (args) => {
      const result = await api.get(`/api/projects/${args.projectId}/plans/active`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_create',
    'Create a new plan draft. OWNER ONLY. Do NOT call this when doing "work as <agent>" delegation — use plansync_plan_suggest instead.',
    {
      projectId: z.string(),
      title: z.string(),
      goal: z.string(),
      scope: z.string(),
      constraints: z.array(z.string()).optional(),
      standards: z.array(z.string()).optional(),
      deliverables: z.array(z.string()).optional(),
      openQuestions: z.array(z.string()).optional(),
      requiredReviewers: z.array(z.string()).optional(),
      asAgent: z
        .string()
        .optional()
        .describe(
          "Delegation: act as this agent so the API enforces their role, not the session user's.",
        ),
    },
    async (args) => {
      const { projectId, asAgent, ...body } = args;
      const effectiveApi = asAgent ? api.withUser(asAgent) : api;
      const result = await effectiveApi.post(`/api/projects/${projectId}/plans`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_update',
    'Update a draft plan. OWNER ONLY. Do NOT call this when doing "work as <agent>" delegation.',
    {
      projectId: z.string(),
      planId: z.string(),
      title: z.string().optional(),
      goal: z.string().optional(),
      scope: z.string().optional(),
      constraints: z.array(z.string()).optional(),
      standards: z.array(z.string()).optional(),
      deliverables: z.array(z.string()).optional(),
      openQuestions: z.array(z.string()).optional(),
      requiredReviewers: z.array(z.string()).optional(),
      changeSummary: z.string().optional(),
      why: z.string().optional(),
      asAgent: z
        .string()
        .optional()
        .describe(
          "Delegation: act as this agent so the API enforces their role, not the session user's.",
        ),
    },
    async (args) => {
      const { projectId, planId, asAgent, ...body } = args;
      const effectiveApi = asAgent ? api.withUser(asAgent) : api;
      const result = await effectiveApi.patch(`/api/projects/${projectId}/plans/${planId}`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_propose',
    'Submit a draft plan for review. OWNER ONLY. Do NOT call this when doing "work as <agent>" delegation.',
    {
      projectId: z.string(),
      planId: z.string().describe('Plan ID of the draft to propose'),
      reviewers: z
        .array(
          z.union([
            z.string(),
            z.object({
              name: z.string(),
              focusNotes: z
                .string()
                .optional()
                .describe(
                  'What this reviewer should focus on (e.g. "backend feasibility", "security constraints")',
                ),
              type: z
                .enum(['human', 'agent'])
                .optional()
                .describe('Member type for auto-added reviewers. Defaults to human.'),
            }),
          ]),
        )
        .optional()
        .describe(
          'Reviewer names or {name, focusNotes} objects. Use focusNotes to tell each reviewer what aspect to focus on.',
        ),
      asAgent: z
        .string()
        .optional()
        .describe(
          "Delegation: act as this agent so the API enforces their role, not the session user's.",
        ),
    },
    async (args) => {
      const { projectId, planId, reviewers, asAgent } = args;
      const effectiveApi = asAgent ? api.withUser(asAgent) : api;
      const result = await effectiveApi.post(`/api/projects/${projectId}/plans/${planId}/propose`, {
        reviewers,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_activate',
    'Activate a plan, superseding the current active plan and triggering drift scan. OWNER ONLY. Do NOT call this when doing "work as <agent>" delegation.',
    {
      projectId: z.string(),
      planId: z.string().describe('Plan ID (not version). Use plansync_plan_list to find it.'),
      asAgent: z
        .string()
        .optional()
        .describe(
          "Delegation: act as this agent so the API enforces their role, not the session user's.",
        ),
    },
    async (args) => {
      const effectiveApi = args.asAgent ? api.withUser(args.asAgent) : api;
      const result = await effectiveApi.post(
        `/api/projects/${args.projectId}/plans/${args.planId}/activate`,
        {},
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_reactivate',
    'Reactivate a superseded plan (rollback). OWNER ONLY. Do NOT call this when doing "work as <agent>" delegation.',
    {
      projectId: z.string(),
      planId: z.string().describe('Plan ID of the superseded plan to reactivate'),
      asAgent: z
        .string()
        .optional()
        .describe(
          "Delegation: act as this agent so the API enforces their role, not the session user's.",
        ),
    },
    async (args) => {
      const effectiveApi = args.asAgent ? api.withUser(args.asAgent) : api;
      const result = await effectiveApi.post(
        `/api/projects/${args.projectId}/plans/${args.planId}/reactivate`,
        {},
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_review_approve',
    'Approve a plan review. Automatically finds your review by your username — no need to look up reviewId. Use asUser to approve on behalf of an agent member (delegation).',
    {
      projectId: z.string(),
      planId: z.string(),
      comment: z.string().optional(),
      asUser: z
        .string()
        .optional()
        .describe(
          'Approve on behalf of this user instead of the current session user (agent delegation)',
        ),
    },
    async (args) => {
      const targetUser = args.asUser ?? getDelegationAgent() ?? config.userName;
      const reviews = await api.get<{ data: Array<{ id: string; reviewerName: string }> }>(
        `/api/projects/${args.projectId}/plans/${args.planId}/reviews`,
      );
      const myReview = reviews.data.find((r) => r.reviewerName === targetUser);
      if (!myReview) {
        throw new Error(`No pending review found for user "${targetUser}" on this plan`);
      }
      const result = await api.post(
        `/api/projects/${args.projectId}/plans/${args.planId}/reviews/${myReview.id}?action=approve`,
        { comment: args.comment },
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_review_reject',
    'Reject a plan review. Automatically finds your review by your username — no need to look up reviewId. Use asUser to reject on behalf of an agent member (delegation).',
    {
      projectId: z.string(),
      planId: z.string(),
      comment: z.string().optional().describe('Required: reason for rejection'),
      asUser: z
        .string()
        .optional()
        .describe(
          'Reject on behalf of this user instead of the current session user (agent delegation)',
        ),
    },
    async (args) => {
      const targetUser = args.asUser ?? getDelegationAgent() ?? config.userName;
      const reviews = await api.get<{ data: Array<{ id: string; reviewerName: string }> }>(
        `/api/projects/${args.projectId}/plans/${args.planId}/reviews`,
      );
      const myReview = reviews.data.find((r) => r.reviewerName === targetUser);
      if (!myReview) {
        throw new Error(`No pending review found for user "${targetUser}" on this plan`);
      }
      const result = await api.post(
        `/api/projects/${args.projectId}/plans/${args.planId}/reviews/${myReview.id}?action=reject`,
        { comment: args.comment },
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_diff',
    'Get AI-generated diff between this plan version and the previous one. Returns changes[], summary, and breakingChanges flag. ' +
      'Call this when reviewing a proposed plan to understand what changed before deciding to approve or reject.',
    {
      projectId: z.string(),
      planId: z.string().describe('Plan ID of the proposed plan to diff against its predecessor'),
    },
    async (args) => {
      const result = await api.get(`/api/projects/${args.projectId}/plans/${args.planId}/diff`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // Incremental array-append tools — preferred over plansync_plan_update when adding many
  // items to deliverables/constraints/standards/openQuestions, because each call stays small
  // and avoids LLM token-budget truncation. Idempotent: items that exact-match an existing
  // entry (after trim) are silently skipped.
  const makeAppender = (
    name: string,
    field: 'deliverables' | 'constraints' | 'standards' | 'openQuestions',
    label: string,
  ) =>
    server.tool(
      name,
      `Append items to a draft plan's ${field} array (max 50 per call). OWNER ONLY. ` +
        `Prefer this over plansync_plan_update when adding many ${label} items — each call ` +
        `stays small enough to avoid token-budget truncation. Idempotent: duplicates skipped. ` +
        `Do NOT call this when doing "work as <agent>" delegation — use plansync_plan_suggest instead.`,
      {
        projectId: z.string(),
        planId: z.string(),
        items: z
          .array(z.string().min(1).max(2000))
          .min(1)
          .max(50)
          .describe(`Items to append (max 50 per call). Call again for more.`),
        asAgent: z.string().optional(),
      },
      async (args) => {
        const { projectId, planId, items, asAgent } = args;
        const effectiveApi = asAgent ? api.withUser(asAgent) : api;
        const result = await effectiveApi.post(
          `/api/projects/${projectId}/plans/${planId}/append`,
          { field, items },
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    );

  makeAppender('plansync_plan_deliverables_append', 'deliverables', 'deliverable');
  makeAppender('plansync_plan_constraints_append', 'constraints', 'constraint');
  makeAppender('plansync_plan_standards_append', 'standards', 'standard');
  makeAppender('plansync_plan_open_questions_append', 'openQuestions', 'open question');
}

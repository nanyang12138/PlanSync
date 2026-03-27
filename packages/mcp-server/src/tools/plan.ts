import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient } from '../api-client';

export function registerPlanTools(server: McpServer, api: ApiClient) {
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
    'Create a new plan draft',
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
    },
    async (args) => {
      const { projectId, ...body } = args;
      const result = await api.post(`/api/projects/${projectId}/plans`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_update',
    'Update a draft plan (owner only)',
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
      changeSummary: z.string().optional(),
      why: z.string().optional(),
    },
    async (args) => {
      const { projectId, planId, ...body } = args;
      const result = await api.patch(`/api/projects/${projectId}/plans/${planId}`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_propose',
    'Submit a draft plan for review (owner only)',
    {
      projectId: z.string(),
      planId: z.string().describe('Plan ID of the draft to propose'),
    },
    async (args) => {
      const result = await api.post(`/api/projects/${args.projectId}/plans/${args.planId}/propose`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_activate',
    'Activate a plan, superseding the current active plan and triggering drift scan (owner only). Use planId, not version number.',
    {
      projectId: z.string(),
      planId: z.string().describe('Plan ID (not version). Use plansync_plan_list to find it.'),
    },
    async (args) => {
      const result = await api.post(`/api/projects/${args.projectId}/plans/${args.planId}/activate`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_reactivate',
    'Reactivate a superseded plan (rollback). Use planId, not version number.',
    {
      projectId: z.string(),
      planId: z.string().describe('Plan ID of the superseded plan to reactivate'),
    },
    async (args) => {
      const result = await api.post(`/api/projects/${args.projectId}/plans/${args.planId}/reactivate`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_review_approve',
    'Approve a plan review. Internally translates planId to the review matching the current user.',
    {
      projectId: z.string(),
      planId: z.string(),
      reviewId: z.string(),
      comment: z.string().optional(),
    },
    async (args) => {
      const result = await api.post(
        `/api/projects/${args.projectId}/plans/${args.planId}/reviews/${args.reviewId}?action=approve`,
        { comment: args.comment },
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_review_reject',
    'Reject a plan review with a reason',
    {
      projectId: z.string(),
      planId: z.string(),
      reviewId: z.string(),
      comment: z.string().optional(),
    },
    async (args) => {
      const result = await api.post(
        `/api/projects/${args.projectId}/plans/${args.planId}/reviews/${args.reviewId}?action=reject`,
        { comment: args.comment },
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}

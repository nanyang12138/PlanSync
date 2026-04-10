import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient } from '../api-client';
import { McpConfig } from '../config';

let activeDelegationAgent: string | undefined;

export function getDelegationAgent(): string | undefined {
  return activeDelegationAgent;
}

export function registerStatusTools(server: McpServer, api: ApiClient, config: McpConfig) {
  server.tool(
    'plansync_status',
    'Get project alignment status: active plan version, task breakdown, drift alerts, recent activity. Call at session start.',
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
    'plansync_who',
    'Show who is currently executing tasks and which plan version they are bound to.',
    { projectId: z.string() },
    async (args) => {
      const dashboard = await api.get<{ data: Record<string, unknown> }>(
        `/api/projects/${args.projectId}/dashboard`,
      );
      const data = dashboard.data as Record<string, unknown>;
      const tasks = (data.tasks || []) as Array<Record<string, unknown>>;
      const active = tasks.filter((t) => t.status === 'in_progress' && t.assignee);
      const executors = active.map((t) => ({
        assignee: t.assignee,
        assigneeType: t.assigneeType,
        taskId: t.id,
        taskTitle: t.title,
        boundPlanVersion: t.boundPlanVersion,
      }));
      return {
        content: [
          { type: 'text', text: JSON.stringify({ executors, count: executors.length }, null, 2) },
        ],
      };
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
      const result = await api.get(
        `/api/projects/${args.projectId}/activities${qs ? `?${qs}` : ''}`,
      );
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
    'Resolve a drift alert. Choose: rebind (accept new plan and continue) / no_impact (change does not affect this task) / cancel (release the task).',
    {
      projectId: z.string(),
      driftId: z.string(),
      action: z
        .enum(['rebind', 'cancel', 'no_impact'])
        .describe(
          'rebind: update task to new plan, cancel: cancel the task, no_impact: mark as non-issue',
        ),
    },
    async (args) => {
      const result = await api.post(`/api/projects/${args.projectId}/drifts/${args.driftId}`, {
        action: args.action,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_my_work',
    'View all pending work assigned to you (or a named agent): plans awaiting review, assigned tasks, drift alerts. Call at session start. Returns items sorted by priority: drifts (P0) > reviews (P1) > tasks (P2). Use agentName to query work on behalf of an agent member.',
    {
      projectId: z.string().optional(),
      agentName: z
        .string()
        .optional()
        .describe('Query work for this agent instead of the current user (agent delegation)'),
    },
    async (args) => {
      const targetUser = args.agentName ?? config.userName;

      // Enter/exit delegation mode based on whether agentName is provided
      if (args.agentName) {
        activeDelegationAgent = args.agentName;
      } else {
        activeDelegationAgent = undefined;
      }

      // No projectId: use cross-project /api/my-work endpoint
      if (!args.projectId) {
        const result = await api.get<{
          reviews: Array<Record<string, unknown>>;
          drifts: Array<Record<string, unknown>>;
          tasks: Array<Record<string, unknown>>;
        }>('/api/my-work');
        const { reviews = [], drifts = [], tasks = [] } = result;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  targetUser,
                  hasWork: reviews.length + drifts.length + tasks.length > 0,
                  driftAlerts: drifts,
                  pendingReviews: reviews,
                  pendingTasks: tasks,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // projectId provided: per-project mode (backward compatible)
      // P2: tasks assigned to targetUser with pending status
      const tasksRes = await api.get<{ data: Array<Record<string, unknown>> }>(
        `/api/projects/${args.projectId}/tasks?assignee=${encodeURIComponent(targetUser)}`,
      );
      const pendingTasks = (tasksRes.data || [])
        .filter((t) => ['todo', 'in_progress', 'blocked'].includes(t.status as string))
        .map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority }));

      // P1: plans proposed for review by targetUser
      const plansRes = await api.get<{ data: Array<Record<string, unknown>> }>(
        `/api/projects/${args.projectId}/plans?pageSize=50`,
      );
      const proposedForMe = (plansRes.data || []).filter(
        (p) =>
          p.status === 'proposed' &&
          (p.requiredReviewers as string[] | undefined)?.includes(targetUser),
      );
      const pendingReviews: Array<Record<string, unknown>> = [];
      for (const plan of proposedForMe) {
        const reviewsRes = await api.get<{ data: Array<Record<string, unknown>> }>(
          `/api/projects/${args.projectId}/plans/${plan.id}/reviews`,
        );
        const myReview = (reviewsRes.data || []).find(
          (r) => r.reviewerName === targetUser && r.status === 'pending',
        );
        if (myReview) {
          pendingReviews.push({
            planId: plan.id,
            planTitle: plan.title,
            version: plan.version,
            proposedBy: plan.proposedBy,
            reviewId: myReview.id,
            focusNotes: myReview.focusNotes ?? null,
          });
        }
      }

      // P0: drift alerts on targetUser's tasks
      const driftsRes = await api.get<{ data: Array<Record<string, unknown>> }>(
        `/api/projects/${args.projectId}/drifts?status=open`,
      );
      const myTaskIds = new Set(pendingTasks.map((t) => t.id));
      const driftAlerts = (driftsRes.data || [])
        .filter((d) => myTaskIds.has(d.taskId as string))
        .map((d) => ({
          id: d.id,
          taskId: d.taskId,
          taskTitle: d.taskTitle,
          severity: d.severity,
          reason: d.reason,
        }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                targetUser,
                hasWork: pendingTasks.length + pendingReviews.length + driftAlerts.length > 0,
                driftAlerts,
                pendingReviews,
                pendingTasks,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    'plansync_delegation_clear',
    'Exit delegation mode (end "work as <agent>" session). Call this when finished processing an agent\'s work.',
    {},
    async () => {
      const previous = activeDelegationAgent;
      activeDelegationAgent = undefined;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ cleared: true, previousAgent: previous ?? null }),
          },
        ],
      };
    },
  );
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient } from '../api-client';
import { getDelegationAgent } from './status';

export function registerTaskTools(server: McpServer, api: ApiClient) {
  // In delegation mode ("work as <agent>"), any write that records the caller's
  // identity (claim/decline/update task) must be issued as that agent — not as
  // the human owner who is driving the session. Without this, claims land on
  // the owner's name and tasks look like the wrong person picked them up.
  const effectiveApi = (): ApiClient => {
    const agent = getDelegationAgent();
    return agent ? api.withUser(agent) : api;
  };
  server.tool(
    'plansync_task_list',
    'List tasks for a project with optional filters',
    {
      projectId: z.string(),
      status: z
        .string()
        .optional()
        .describe('Filter by status: todo, in_progress, blocked, done, cancelled'),
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
    'Get task details including drift alert status and recent execution runs',
    { projectId: z.string(), taskId: z.string() },
    async (args) => {
      // Use pack endpoint to include drift alerts alongside task data
      const result = await api.get(`/api/projects/${args.projectId}/tasks/${args.taskId}/pack`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_task_create',
    'Create a new task (auto-binds to active plan version). OWNER ONLY.',
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
      planDeliverableRefs: z
        .array(z.string())
        .optional()
        .describe(
          'Which plan deliverables this task is responsible for. execution_complete AI verification will check only these, not all plan deliverables.',
        ),
      planConstraintRefs: z
        .array(z.string())
        .optional()
        .describe(
          'Drift v2: which plan constraints this task depends on. Empty/omitted = "depends on all" (conservative — any constraint change is breaking). Narrow per task to reduce false drift alerts. Owner-only.',
        ),
      planStandardRefs: z
        .array(z.string())
        .optional()
        .describe(
          'Drift v2: which plan standards this task depends on. Empty/omitted = "depends on all". Owner-only.',
        ),
    },
    async (args) => {
      const { projectId, ...body } = args;
      const result = await effectiveApi().post(`/api/projects/${projectId}/tasks`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_task_update',
    'Update a task (supports reassignment via assignee/assigneeType)',
    {
      projectId: z.string(),
      taskId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z
        .enum(['todo', 'in_progress', 'blocked', 'cancelled'])
        .optional()
        .describe(
          '"done" cannot be set directly — use plansync_execution_complete instead (requires deliverablesMet and AI verification for agents)',
        ),
      priority: z.enum(['p0', 'p1', 'p2']).optional(),
      assignee: z.string().nullable().optional().describe('Set assignee name, or null to unassign'),
      assigneeType: z.enum(['human', 'agent', 'unassigned']).optional(),
      planDeliverableRefs: z
        .array(z.string())
        .optional()
        .describe(
          'Which plan deliverables this task is responsible for. execution_complete AI verification will check only these, not all plan deliverables.',
        ),
      planConstraintRefs: z
        .array(z.string())
        .optional()
        .describe(
          'Drift v2: which plan constraints this task depends on. Empty = "depends on all". Owner-only.',
        ),
      planStandardRefs: z
        .array(z.string())
        .optional()
        .describe(
          'Drift v2: which plan standards this task depends on. Empty = "depends on all". Owner-only.',
        ),
    },
    async (args) => {
      const { projectId, taskId, ...body } = args;
      const result = await effectiveApi().patch(`/api/projects/${projectId}/tasks/${taskId}`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_task_claim',
    'Claim an unassigned task. After claiming, call plansync_task_pack to receive your task brief and plan context.',
    {
      projectId: z.string(),
      taskId: z.string(),
      assigneeType: z.enum(['human', 'agent']).optional(),
      startImmediately: z
        .boolean()
        .optional()
        .describe('If false, accept assignment but keep status as todo. Default: true'),
    },
    async (args) => {
      const client = effectiveApi();
      const result = await client.post(
        `/api/projects/${args.projectId}/tasks/${args.taskId}/claim`,
        {
          assigneeType: args.assigneeType || 'agent',
          ...(args.startImmediately !== undefined
            ? { startImmediately: args.startImmediately }
            : {}),
        },
      );
      const verify = await client.get<{ data?: { status?: string } }>(
        `/api/projects/${args.projectId}/tasks/${args.taskId}`,
      );
      const verifiedStatus = verify.data?.status ?? 'unknown';
      const expectedStatus = args.startImmediately === false ? 'todo' : 'in_progress';
      if (verifiedStatus !== expectedStatus) {
        return {
          content: [
            {
              type: 'text',
              text:
                `Claim call succeeded but task status is still "${verifiedStatus}", not "${expectedStatus}". ` +
                `Tell the user the claim may have failed.`,
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_task_decline',
    'Release a task you cannot complete. Task returns to unassigned and can be reassigned.',
    {
      projectId: z.string(),
      taskId: z.string(),
    },
    async (args) => {
      const client = effectiveApi();
      const result = await client.post(
        `/api/projects/${args.projectId}/tasks/${args.taskId}/decline`,
        {},
      );
      const verify = await client.get<{ data?: { assignee?: string | null } }>(
        `/api/projects/${args.projectId}/tasks/${args.taskId}`,
      );
      const verifiedAssignee = verify.data?.assignee;
      if (verifiedAssignee !== null && verifiedAssignee !== undefined && verifiedAssignee !== '') {
        return {
          content: [
            {
              type: 'text',
              text:
                `Decline call succeeded but task still has assignee "${verifiedAssignee}". ` +
                `Tell the user the decline may have failed.`,
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_task_pack',
    'Must call before starting any task. Returns your task brief: goal, plan context (constraints, standards, deliverables), and any drift alerts that must be resolved first.',
    { projectId: z.string(), taskId: z.string() },
    async (args) => {
      const result = await api.get(`/api/projects/${args.projectId}/tasks/${args.taskId}/pack`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}

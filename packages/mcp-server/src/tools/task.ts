import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createTaskShape, updateTaskShape } from '@plansync/shared';
import { ApiClient } from '../api-client';
import { logger } from '../logger';
import {
  handleTaskCreate,
  handleTaskUpdate,
  handleTaskClaim,
  handleTaskDecline,
} from './task-handlers';

export function registerTaskTools(server: McpServer, api: ApiClient) {
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
    // R-209: this is the READ-ONLY inspection view. It is NOT the pre-work
    // gate — before you START a task call plansync_task_pack, which returns
    // the same open drift alerts you MUST resolve before execution_start.
    // Choosing task_show as your pre-work check does not relieve you of that
    // obligation. (Previously this description claimed "recent execution
    // runs" but only hit /pack, which omits them — that lie is fixed below.)
    'Read-only task view: full task details, plan context, OPEN drift alerts, and the ' +
      '5 most recent execution runs. For inspection only — before STARTING work on a task ' +
      'call plansync_task_pack instead: that is the required pre-work gate (it returns the ' +
      'same drift alerts, which must be resolved before execution_start).',
    { projectId: z.string(), taskId: z.string() },
    async (args) => {
      // R-209: return what the description promises. /pack carries task +
      // plan + project + open drift alerts but NOT execution runs; the plain
      // task GET carries the 5 most recent runs but NOT drift alerts. Fetch
      // both and merge so this tool is a genuine rich read AND never silently
      // drops the drift signal an agent might be relying on.
      const [pack, detail] = await Promise.all([
        api.get<{ data?: Record<string, unknown> }>(
          `/api/projects/${args.projectId}/tasks/${args.taskId}/pack`,
        ),
        api.get<{ data?: { executionRuns?: unknown } }>(
          `/api/projects/${args.projectId}/tasks/${args.taskId}`,
        ),
      ]);
      const merged = {
        data: {
          ...(pack?.data ?? {}),
          recentExecutionRuns: detail?.data?.executionRuns ?? [],
        },
      };
      return { content: [{ type: 'text', text: JSON.stringify(merged, null, 2) }] };
    },
  );

  // R-205 — legacy aliases. These four tool names stay registered for one
  // release so any agent prompt that hasn't migrated to
  // `plansync_task(action, ...)` (CLAUDE.md / AGENTS.md / cli ai-loop /
  // third-party MCP clients) keeps working. The handlers delegate to the
  // same `handleTask*` helpers as `plansync_task`, so wire behaviour is
  // bit-identical across the two surfaces. Each handler also emits a
  // deprecation warning to the server log on every call — ops can grep
  // `R-205 deprecated alias` to identify callers that still need
  // migration before the next release drops the aliases.

  // R-028: input schema reuses @plansync/shared `createTaskShape` so MCP and
  // the API stay in lockstep — adding a field to the contract automatically
  // surfaces it here (previously the MCP copy lacked `branchName`, `startDate`,
  // `dueDate`, and was missing the `test` / `docs` task types).
  server.tool(
    'plansync_task_create',
    '[DEPRECATED — use plansync_task({action:"create", ...})] Create a new task ' +
      '(auto-binds to active plan version). OWNER ONLY. Will be removed in the next release.',
    {
      projectId: z.string(),
      ...createTaskShape,
    },
    async (args) => {
      logger.warn(
        { tool: 'plansync_task_create' },
        'R-205 deprecated alias called — migrate to plansync_task({action:"create", ...})',
      );
      const { projectId, ...body } = args;
      return handleTaskCreate({ projectId, body }, { api });
    },
  );

  // R-027: input schema reuses @plansync/shared `updateTaskShape`. Previously
  // the MCP copy was missing `type`, `branchName`, `prUrl`, `agentContext`,
  // `expectedOutput`, `agentConstraints`, `startDate`, and `dueDate`, so agents
  // could not update those fields through MCP at all.
  //
  // Note: shared schema accepts status='done' (the API rejects it at the route
  // layer with a "use plansync_run({action:'complete', ...})" error). We rely
  // on the API to enforce that rule rather than re-validating here.
  server.tool(
    'plansync_task_update',
    '[DEPRECATED — use plansync_task({action:"update", ...})] Update a task ' +
      '(supports reassignment via assignee/assigneeType). "done" status cannot be set directly ' +
      '— use plansync_run({action:"complete", ...}) instead. Will be removed in the next release.',
    {
      projectId: z.string(),
      taskId: z.string(),
      ...updateTaskShape,
    },
    async (args) => {
      logger.warn(
        { tool: 'plansync_task_update' },
        'R-205 deprecated alias called — migrate to plansync_task({action:"update", ...})',
      );
      const { projectId, taskId, ...body } = args;
      return handleTaskUpdate({ projectId, taskId, body }, { api });
    },
  );

  server.tool(
    'plansync_task_claim',
    '[DEPRECATED — use plansync_task({action:"claim", ...})] Claim an unassigned task. ' +
      'After claiming, call plansync_task_pack to receive your task brief and plan context. ' +
      'Will be removed in the next release.',
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
      logger.warn(
        { tool: 'plansync_task_claim' },
        'R-205 deprecated alias called — migrate to plansync_task({action:"claim", ...})',
      );
      return handleTaskClaim(args, { api });
    },
  );

  server.tool(
    'plansync_task_decline',
    '[DEPRECATED — use plansync_task({action:"decline", ...})] Release a task you cannot ' +
      'complete. Task returns to unassigned and can be reassigned. Will be removed in the next release.',
    {
      projectId: z.string(),
      taskId: z.string(),
    },
    async (args) => {
      logger.warn(
        { tool: 'plansync_task_decline' },
        'R-205 deprecated alias called — migrate to plansync_task({action:"decline", ...})',
      );
      return handleTaskDecline(args, { api });
    },
  );

  server.tool(
    'plansync_task_pack',
    'Must call before starting any task. Returns your task brief: goal, plan context ' +
      '(constraints, standards, deliverables), and any drift alerts that must be resolved ' +
      'first. This is the canonical pre-work GATE; plansync_task_show is only the read-only ' +
      'inspection sibling and does not satisfy this obligation.',
    { projectId: z.string(), taskId: z.string() },
    async (args) => {
      const result = await api.get(`/api/projects/${args.projectId}/tasks/${args.taskId}/pack`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}

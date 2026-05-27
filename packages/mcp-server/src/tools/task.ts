/**
 * R-205 — Task tool surface consolidation.
 *
 * Five legacy tools (`plansync_task_create / update / claim / decline /
 * rebind`) are folded into a single `plansync_task(action, args)` tool with
 * a discriminated `action` field, mirroring the R-204 pattern that
 * collapsed the three `plansync_execution_*` tools into `plansync_run`.
 *
 * Both surfaces stay registered for one release: the legacy aliases keep
 * working (with a `[DEPRECATED]` tag and a logger.warn on every call) so
 * any agent prompt that still references them does not break, and the new
 * unified tool advertises the canonical surface in `tools/list`.
 *
 * The `handleTask*` helpers below are the single source of truth for wire
 * behaviour — both the legacy aliases and the unified tool route through
 * them so URL routing, body shape, and post-call verification GETs stay
 * bit-identical regardless of which surface the caller picked.
 *
 * `plansync_task_rebind` is intentionally consolidated here as well, even
 * though the legacy tool was registered in `tools/status.ts`. Keeping the
 * unified surface in one file matches the file layout that the
 * remediation plan asks for (`packages/mcp-server/src/tools/task.ts`
 * (consolidate)) and avoids duplicating the handler across two modules.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createTaskShape, updateTaskShape } from '@plansync/shared';
import { ApiClient } from '../api-client';
import { logger } from '../logger';
import { getDelegationAgent } from './status';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/**
 * In delegation mode ("work as <agent>"), every write that records the
 * caller's identity (claim/decline/update task) must be issued as that
 * agent — not as the human owner who is driving the session. Without this,
 * claims land on the owner's name and tasks look like the wrong person
 * picked them up.
 *
 * `task_rebind` historically used the unwrapped `api` because it's a
 * system-level operation that records the resolver in the audit trail
 * separately. We preserve that asymmetry verbatim so behaviour is
 * unchanged.
 */
function effectiveApi(api: ApiClient): ApiClient {
  const agent = getDelegationAgent();
  return agent ? api.withUser(agent) : api;
}

// ----------------------------------------------------------------------------
// Shared handlers — single source of truth for wire behaviour.
// ----------------------------------------------------------------------------

export interface TaskCreateArgs {
  projectId: string;
  body: Record<string, unknown>;
}

export async function handleTaskCreate(
  args: TaskCreateArgs,
  api: ApiClient,
): Promise<ToolResult> {
  const result = await effectiveApi(api).post(
    `/api/projects/${args.projectId}/tasks`,
    args.body,
  );
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export interface TaskUpdateArgs {
  projectId: string;
  taskId: string;
  body: Record<string, unknown>;
}

export async function handleTaskUpdate(
  args: TaskUpdateArgs,
  api: ApiClient,
): Promise<ToolResult> {
  const result = await effectiveApi(api).patch(
    `/api/projects/${args.projectId}/tasks/${args.taskId}`,
    args.body,
  );
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export interface TaskClaimArgs {
  projectId: string;
  taskId: string;
  assigneeType?: 'human' | 'agent';
  startImmediately?: boolean;
}

export async function handleTaskClaim(
  args: TaskClaimArgs,
  api: ApiClient,
): Promise<ToolResult> {
  const client = effectiveApi(api);
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
}

export interface TaskDeclineArgs {
  projectId: string;
  taskId: string;
}

export async function handleTaskDecline(
  args: TaskDeclineArgs,
  api: ApiClient,
): Promise<ToolResult> {
  const client = effectiveApi(api);
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
}

export interface TaskRebindArgs {
  projectId: string;
  taskId: string;
}

/**
 * Rebind keeps using the unwrapped `api` (no `effectiveApi` wrapping) on
 * purpose — the API records the human resolver in the audit trail
 * separately, so wrapping in delegation mode would falsely attribute the
 * rebind to the agent rather than the owner who triggered it.
 */
export async function handleTaskRebind(
  args: TaskRebindArgs,
  api: ApiClient,
): Promise<ToolResult> {
  const result = await api.post(
    `/api/projects/${args.projectId}/tasks/${args.taskId}/rebind`,
  );
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

// ----------------------------------------------------------------------------
// `plansync_task(action, args)` — unified surface (R-205).
// ----------------------------------------------------------------------------

const claimArgsSchema = z
  .object({
    action: z.literal('claim'),
    projectId: z.string(),
    taskId: z.string(),
    assigneeType: z.enum(['human', 'agent']).optional(),
    startImmediately: z.boolean().optional(),
  })
  .strict();

const declineArgsSchema = z
  .object({
    action: z.literal('decline'),
    projectId: z.string(),
    taskId: z.string(),
  })
  .strict();

const rebindArgsSchema = z
  .object({
    action: z.literal('rebind'),
    projectId: z.string(),
    taskId: z.string(),
  })
  .strict();

// `.strict()` on each per-action schema is what enforces "no
// cross-action fields" (parity with R-204's strict-schema guard,
// see issue #2757). The outer SDK shape (registered in
// `registerUnifiedTaskTool` below) intentionally stays loose so a
// single tool surface can advertise the union; this inner layer is
// what actually rejects e.g. `{action: 'create', taskId: '…'}`.
const createArgsSchema = z
  .object({
    action: z.literal('create'),
    projectId: z.string(),
    ...createTaskShape,
  })
  .strict();

const updateArgsSchema = z
  .object({
    action: z.literal('update'),
    projectId: z.string(),
    taskId: z.string(),
    ...updateTaskShape,
  })
  .strict();

const taskArgsSchema = z.discriminatedUnion('action', [
  createArgsSchema,
  updateArgsSchema,
  claimArgsSchema,
  declineArgsSchema,
  rebindArgsSchema,
]);

/**
 * Map a `plansync_task` invocation's `action` field to the legacy tool
 * name the FSM table (`packages/shared/src/protocol/exec-state.ts`) keys
 * on. Exported so `tool-wrapper.ts` can keep the FSM table backwards-
 * compatible during the deprecation cycle.
 *
 * Only `rebind` actually appears in the FSM allowedTools set — the other
 * four task actions are not gated by the FSM (they're delegation/owner
 * surfaces) so the mapping is mostly a defensive translation. Falling
 * through unchanged means the FSM lookup uses `plansync_task` as-is and
 * gets the same OUT_OF_SEQUENCE rejection it would for any unknown name.
 */
export function normalizeTaskToolNameForFsm(toolName: string, args: unknown): string {
  if (toolName !== 'plansync_task') return toolName;
  if (!args || typeof args !== 'object') return toolName;
  const action = (args as { action?: unknown }).action;
  if (action === 'create') return 'plansync_task_create';
  if (action === 'update') return 'plansync_task_update';
  if (action === 'claim') return 'plansync_task_claim';
  if (action === 'decline') return 'plansync_task_decline';
  if (action === 'rebind') return 'plansync_task_rebind';
  return toolName;
}

/**
 * Strip the discriminator + routing fields from a parsed argument bag so
 * the result can be forwarded as a request body / handler arg without
 * leaking the action key.
 */
function stripRouting<T extends { action: string; projectId: string; taskId?: string }>(
  parsed: T,
): Omit<T, 'action' | 'projectId' | 'taskId'> {
  const { action: _action, projectId: _projectId, taskId: _taskId, ...rest } = parsed;
  void _action;
  void _projectId;
  void _taskId;
  return rest as Omit<T, 'action' | 'projectId' | 'taskId'>;
}

export function registerUnifiedTaskTool(server: McpServer, api: ApiClient): void {
  // The McpServer SDK accepts a `ZodRawShape` (record of field → schema)
  // rather than a single schema object. We expose the discriminated union
  // via the shared `action` discriminator and let the inner safeParse
  // narrow based on the value the caller actually passed. The outer SDK
  // shape is intentionally a superset of every action's fields so a
  // single tool registration can advertise the union; the inner
  // `taskArgsSchema.safeParse` (with `.strict()` on the action-specific
  // wrappers) is what enforces "no cross-action fields".
  server.tool(
    'plansync_task',
    'Manage a task via a single tool. `action` discriminator: ' +
      '`create` (OWNER ONLY) creates a new task; ' +
      '`update` patches a task (use plansync_run({action:"complete", ...}) instead of status="done"); ' +
      '`claim` claims an unassigned task and (by default) sets it to in_progress; ' +
      '`decline` releases a claimed task back to unassigned; ' +
      '`rebind` rebinds a task to the current active plan version. ' +
      'Replaces plansync_task_create / update / claim / decline / rebind ' +
      '(deprecated aliases remain registered for one release).',
    {
      action: z
        .enum(['create', 'update', 'claim', 'decline', 'rebind'])
        .describe('Which task operation to perform.'),
      projectId: z.string(),
      taskId: z
        .string()
        .optional()
        .describe('Required for action=update/claim/decline/rebind; omit for action=create.'),
      // `create` / `update` field union — every field is optional at the
      // outer SDK layer. The inner discriminated union below enforces
      // per-action field requirements.
      title: z.string().optional(),
      description: z.string().nullable().optional(),
      type: z.string().optional(),
      priority: z.string().optional(),
      status: z.string().optional(),
      assignee: z.string().nullable().optional(),
      assigneeType: z.string().optional(),
      branchName: z.string().nullable().optional(),
      prUrl: z.string().nullable().optional(),
      agentContext: z.string().nullable().optional(),
      expectedOutput: z.string().nullable().optional(),
      agentConstraints: z.array(z.string()).optional(),
      planDeliverableRefs: z.array(z.string()).optional(),
      planConstraintRefs: z.array(z.string()).optional(),
      planStandardRefs: z.array(z.string()).optional(),
      startDate: z.union([z.string(), z.date()]).nullable().optional(),
      dueDate: z.union([z.string(), z.date()]).nullable().optional(),
      // `claim`-specific
      startImmediately: z
        .boolean()
        .optional()
        .describe(
          'Only valid for action=claim. If false, accept assignment but keep status as todo. Default: true.',
        ),
    },
    async (args) => {
      const parsed = taskArgsSchema.safeParse(args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new Error(`plansync_task: invalid arguments — ${issues}`);
      }
      switch (parsed.data.action) {
        case 'create': {
          const { projectId } = parsed.data;
          const body = stripRouting(parsed.data) as Record<string, unknown>;
          return handleTaskCreate({ projectId, body }, api);
        }
        case 'update': {
          const { projectId, taskId } = parsed.data;
          const body = stripRouting(parsed.data) as Record<string, unknown>;
          return handleTaskUpdate({ projectId, taskId, body }, api);
        }
        case 'claim': {
          const { projectId, taskId, assigneeType, startImmediately } = parsed.data;
          return handleTaskClaim(
            { projectId, taskId, assigneeType, startImmediately },
            api,
          );
        }
        case 'decline': {
          const { projectId, taskId } = parsed.data;
          return handleTaskDecline({ projectId, taskId }, api);
        }
        case 'rebind': {
          const { projectId, taskId } = parsed.data;
          return handleTaskRebind({ projectId, taskId }, api);
        }
      }
    },
  );
}

// ----------------------------------------------------------------------------
// Legacy tool registrations — deprecated aliases kept for one release.
// ----------------------------------------------------------------------------

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
    'Get task details including drift alert status and recent execution runs',
    { projectId: z.string(), taskId: z.string() },
    async (args) => {
      // Use pack endpoint to include drift alerts alongside task data
      const result = await api.get(`/api/projects/${args.projectId}/tasks/${args.taskId}/pack`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // R-205 — legacy alias. `plansync_task` with action='create' is the new
  // canonical surface.
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
      return handleTaskCreate(
        { projectId, body: body as Record<string, unknown> },
        api,
      );
    },
  );

  // R-205 — legacy alias.
  server.tool(
    'plansync_task_update',
    '[DEPRECATED — use plansync_task({action:"update", ...})] Update a task (supports ' +
      'reassignment via assignee/assigneeType). "done" status cannot be set directly — ' +
      'use plansync_run({action:"complete", ...}) instead. Will be removed in the next release.',
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
      return handleTaskUpdate(
        { projectId, taskId, body: body as Record<string, unknown> },
        api,
      );
    },
  );

  // R-205 — legacy alias.
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
      return handleTaskClaim(args, api);
    },
  );

  // R-205 — legacy alias.
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
      return handleTaskDecline(args, api);
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

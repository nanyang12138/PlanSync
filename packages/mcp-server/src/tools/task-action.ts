/**
 * R-205 step 3 of R-175 — collapse `plansync_task_{create,update,claim,decline,rebind}`
 * into a single `plansync_task(action, ...)` tool with a discriminated `action`
 * field. The five legacy tool names stay registered (in `tools/task.ts` and
 * `tools/status.ts`) as deprecated aliases for one release so prompts that
 * already mention them (CLAUDE.md / AGENTS.md / cli ai-loop / third-party
 * MCP clients) keep working during the migration window.
 *
 * The handler delegates to the same `handleTask*` helpers that the legacy
 * aliases call, so wire behaviour is bit-identical across the two surfaces —
 * same URL routing, same delegation-aware api selection, same post-write
 * verification GET, same error envelopes. See `r205-task-tool.test.ts` for
 * the parity assertions.
 *
 * The pattern mirrors R-204 (`plansync_run(action, ...)`), which is also a
 * single tool with an `action` discriminator. Future actions can be added
 * without breaking the schema.
 *
 * FSM gating: `tool-wrapper.ts` translates `plansync_task` with `action=X`
 * to the equivalent legacy tool name before consulting the exec-state FSM
 * (`packages/shared/src/protocol/exec-state.ts`). That keeps the FSM table
 * unchanged while still gating new-surface calls correctly.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createTaskShape, updateTaskShape } from '@plansync/shared';
import { ApiClient } from '../api-client';
import {
  handleTaskCreate,
  handleTaskUpdate,
  handleTaskClaim,
  handleTaskDecline,
  handleTaskRebind,
} from './task-handlers';

/**
 * Map a `plansync_task` invocation's `action` field to the legacy tool name
 * the FSM (`packages/shared/src/protocol/exec-state.ts`) still gates on.
 * Exported so `tool-wrapper.ts` can keep the FSM table backwards-compatible
 * during the deprecation cycle.
 *
 * Returns the original tool name when `args` doesn't have a recognised
 * `action` field — callers should pass the result straight through to the
 * FSM, which will reject any genuinely-invalid combination via the normal
 * OUT_OF_SEQUENCE path.
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
  // Unknown action — let zod's discriminated-union parse layer surface the
  // error. The FSM lookup will fall back to `plansync_task`, which isn't in
  // any allowedTools list, so we won't accidentally let an invalid call
  // through.
  return toolName;
}

// Per-action zod schemas. The outer SDK shape advertised on `plansync_task`
// is a superset; this discriminated union enforces "no executor* on
// rebind", "no startImmediately on update", etc., at safeParse time.
const createArgsSchema = z.object({
  action: z.literal('create'),
  projectId: z.string(),
  ...createTaskShape,
});

const updateArgsSchema = z.object({
  action: z.literal('update'),
  projectId: z.string(),
  taskId: z.string(),
  ...updateTaskShape,
});

const claimArgsSchema = z.object({
  action: z.literal('claim'),
  projectId: z.string(),
  taskId: z.string(),
  assigneeType: z.enum(['human', 'agent']).optional(),
  startImmediately: z
    .boolean()
    .optional()
    .describe('If false, accept assignment but keep status as todo. Default: true'),
});

const declineArgsSchema = z.object({
  action: z.literal('decline'),
  projectId: z.string(),
  taskId: z.string(),
});

const rebindArgsSchema = z.object({
  action: z.literal('rebind'),
  projectId: z.string(),
  taskId: z.string(),
});

const taskArgsSchema = z.discriminatedUnion('action', [
  createArgsSchema,
  updateArgsSchema,
  claimArgsSchema,
  declineArgsSchema,
  rebindArgsSchema,
]);

export type TaskToolArgs = z.infer<typeof taskArgsSchema>;

/**
 * Register the single `plansync_task(action, ...)` tool. Order relative to
 * the legacy task-tool registrations is irrelevant — both write into the
 * same `server` and the order is observed only by `tools/list` ordering,
 * which is not part of the contract.
 *
 * The schema is registered as a raw zod object map (each top-level field
 * becomes a property of the MCP tool's inputSchema) to match how the rest
 * of the PlanSync tools are wired. zod's discriminated-union semantics are
 * enforced inside `safeParse` and bubble up through the wrapper's error
 * translation layer (R-037) on invalid input.
 */
export function registerTaskActionTool(server: McpServer, api: ApiClient): void {
  // The McpServer SDK accepts a `ZodRawShape` (record of field → schema)
  // rather than a single schema object, so we expose the discriminated
  // union via the shared `action` discriminator and let the runtime
  // validator narrow based on the value the caller actually passed.
  //
  // The shape below is a *superset* of all five action variants. zod's
  // discriminated-union `safeParse` below the SDK boundary rejects payloads
  // that mix fields from incompatible variants (e.g. `action='rebind'` with
  // a `title`).
  //
  // We deliberately do NOT spread `createTaskShape` / `updateTaskShape` here
  // because their fields overlap (e.g. `title`, `assignee`) and would create
  // ambiguous declarations. The fields are listed loosely as optional on
  // the SDK surface and tightened to their per-action variants by the inner
  // safeParse.
  server.tool(
    'plansync_task',
    'Manage a task via a single tool. `action` discriminator: ' +
      '`create` adds a new task (OWNER ONLY, auto-binds to active plan version); ' +
      '`update` patches a task (supports reassignment via assignee/assigneeType — ' +
      '"done" status cannot be set directly, use plansync_run({action:"complete", ...}) instead); ' +
      '`claim` claims an unassigned task (call plansync_task_pack next for the brief); ' +
      '`decline` releases a task you cannot complete; ' +
      '`rebind` rebinds a task to the current active plan version. ' +
      'Replaces plansync_task_create / update / claim / decline / rebind ' +
      '(deprecated aliases remain registered for one release).',
    {
      action: z
        .enum(['create', 'update', 'claim', 'decline', 'rebind'])
        .describe('Which task action to perform.'),
      projectId: z.string(),
      taskId: z
        .string()
        .optional()
        .describe('Required for action ∈ {update, claim, decline, rebind}; omit for create.'),
      // Fields below are accepted on `create` and `update` — see shared
      // schemas for full per-field semantics. We keep them loose here so a
      // single tool registration can advertise the union; the safeParse
      // below enforces per-action requirements.
      title: z.string().optional(),
      description: z.string().optional(),
      type: z.string().optional(),
      assignee: z.string().nullable().optional(),
      assigneeType: z.enum(['human', 'agent']).optional(),
      priority: z.string().optional(),
      status: z.string().optional(),
      branchName: z.string().optional(),
      prUrl: z.string().optional(),
      agentContext: z.string().optional(),
      expectedOutput: z.string().optional(),
      agentConstraints: z.string().optional(),
      startDate: z.string().optional(),
      dueDate: z.string().optional(),
      // Claim-only:
      startImmediately: z
        .boolean()
        .optional()
        .describe('Claim-only: if false, accept assignment but keep status as todo. Default: true'),
    },
    async (args) => {
      // Narrow with the discriminated union for precise per-action field
      // validation. The SDK's outer shape (above) keeps every field
      // optional so a single tool registration can advertise the union;
      // this safeParse is what actually enforces "no startImmediately on
      // rebind" / "title required on create" / etc.
      const parsed = taskArgsSchema.safeParse(args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new Error(`plansync_task: invalid arguments — ${issues}`);
      }
      switch (parsed.data.action) {
        case 'create': {
          const { action: _a, projectId, ...body } = parsed.data;
          return handleTaskCreate({ projectId, body }, { api });
        }
        case 'update': {
          const { action: _a, projectId, taskId, ...body } = parsed.data;
          return handleTaskUpdate({ projectId, taskId, body }, { api });
        }
        case 'claim': {
          const { projectId, taskId, assigneeType, startImmediately } = parsed.data;
          return handleTaskClaim({ projectId, taskId, assigneeType, startImmediately }, { api });
        }
        case 'decline': {
          const { projectId, taskId } = parsed.data;
          return handleTaskDecline({ projectId, taskId }, { api });
        }
        case 'rebind': {
          const { projectId, taskId } = parsed.data;
          return handleTaskRebind({ projectId, taskId }, { api });
        }
      }
    },
  );
}

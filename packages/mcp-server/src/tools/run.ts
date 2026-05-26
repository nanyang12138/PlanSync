/**
 * R-204 step 2 of R-175 — collapse `plansync_execution_{start,heartbeat,complete}`
 * into a single `plansync_run(action, ...)` tool with a discriminated `action`
 * field. The three legacy tool names stay registered (in `tools/execution.ts`)
 * as deprecated aliases for one release so prompts that already mention them
 * (CLAUDE.md / AGENTS.md / cli ai-loop / third-party MCP clients) keep working
 * during the migration window.
 *
 * The handler delegates to the same `handleExecution*` helpers that the
 * legacy aliases call, so wire behaviour is bit-identical across the two
 * surfaces — same URL routing, same auto-heartbeat lifecycle, same error
 * envelopes. See `r204-run-tool.test.ts` for the parity assertions.
 *
 * The pattern mirrors R-175 step 1 (`plansync_plan_patch`), which is also a
 * single tool with an `op` discriminator. Future ops (e.g.
 * `{action:'cancel'}`) can be added without breaking the schema.
 *
 * FSM gating: `tool-wrapper.ts` translates `plansync_run` with `action=X`
 * to the equivalent legacy tool name before consulting the exec-state FSM
 * (`packages/shared/src/protocol/exec-state.ts`). That keeps the FSM table
 * unchanged while still gating new-surface calls correctly.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient } from '../api-client';
import {
  handleExecutionStart,
  handleExecutionHeartbeat,
  handleExecutionComplete,
  makeDriftCallback,
} from './execution';

/**
 * Map a `plansync_run` invocation's `action` field to the legacy tool name
 * the FSM (`packages/shared/src/protocol/exec-state.ts`) still gates on.
 * Exported so `tool-wrapper.ts` can keep the FSM table backwards-compatible
 * during the deprecation cycle.
 *
 * Returns the original tool name when `args` doesn't have a recognised
 * `action` field — callers should pass the result straight through to the
 * FSM, which will reject any genuinely-invalid combination via the normal
 * OUT_OF_SEQUENCE path.
 */
export function normalizeRunToolNameForFsm(toolName: string, args: unknown): string {
  if (toolName !== 'plansync_run') return toolName;
  if (!args || typeof args !== 'object') return toolName;
  const action = (args as { action?: unknown }).action;
  if (action === 'start') return 'plansync_execution_start';
  if (action === 'heartbeat') return 'plansync_execution_heartbeat';
  if (action === 'complete') return 'plansync_execution_complete';
  // Unknown action — let zod's discriminated-union parse layer surface the
  // error. The FSM lookup will fall back to `plansync_run`, which isn't in
  // any allowedTools list, so we won't accidentally let an invalid call
  // through.
  return toolName;
}

const startArgsSchema = z.object({
  action: z.literal('start'),
  projectId: z.string(),
  taskId: z.string(),
  executorType: z.enum(['human', 'agent']),
  executorName: z.string(),
});

const heartbeatArgsSchema = z.object({
  action: z.literal('heartbeat'),
  projectId: z.string(),
  taskId: z.string(),
  runId: z.string(),
});

const completeArgsSchema = z.object({
  action: z.literal('complete'),
  projectId: z.string(),
  taskId: z.string(),
  runId: z.string(),
  status: z.enum(['completed', 'failed']),
  outputSummary: z.string().optional(),
  filesChanged: z.array(z.string()).optional(),
  blockers: z.array(z.string()).optional(),
  driftSignals: z.array(z.string()).optional(),
  branchName: z.string().optional().describe('Git branch name where changes were committed.'),
  deliverablesMet: z
    .array(z.string())
    .optional()
    .describe(
      'Required when status=completed. List each plan deliverable and confirm it was met. Will be AI-verified for agent executors.',
    ),
});

const runArgsSchema = z.discriminatedUnion('action', [
  startArgsSchema,
  heartbeatArgsSchema,
  completeArgsSchema,
]);

export type RunToolArgs = z.infer<typeof runArgsSchema>;

/**
 * Register the single `plansync_run(action, ...)` tool. Must be called
 * before the legacy `registerExecutionTools` is invoked is irrelevant —
 * both write into the same `server` and the order is observed only by
 * `tools/list` ordering, which is not part of the contract.
 *
 * The schema is registered as a raw zod object map (each top-level field
 * becomes a property of the MCP tool's inputSchema) to match how the rest
 * of the PlanSync tools are wired. zod's discriminated-union semantics are
 * enforced inside `safeParse` and bubble up through the wrapper's error
 * translation layer (R-037) on invalid input.
 */
export function registerRunTool(server: McpServer, api: ApiClient): void {
  // The McpServer SDK accepts a `ZodRawShape` (record of field → schema)
  // rather than a single schema object, so we expose the discriminated
  // union via the shared `action` discriminator and let the runtime
  // validator narrow based on the value the caller actually passed.
  //
  // The shape below is a *superset* of all three action variants. zod's
  // discriminated-union `safeParse` below the SDK boundary rejects payloads
  // that mix fields from incompatible variants (e.g. `action='heartbeat'`
  // with an `executorName`).
  server.tool(
    'plansync_run',
    'Manage an execution run via a single tool. `action` discriminator: ' +
      '`start` registers a run (binds your work to the current plan version, auto-heartbeat every 30s); ' +
      '`heartbeat` manually pings a running run (auto-heartbeat already does this every 30s); ' +
      '`complete` finishes or fails the run (status=completed REQUIRES deliverablesMet — list each plan ' +
      'deliverable and confirm it was met; agent executors get AI verification with a score breakdown ' +
      'on failure). Replaces plansync_execution_start / heartbeat / complete (deprecated aliases ' +
      'remain registered for one release).',
    {
      action: z
        .enum(['start', 'heartbeat', 'complete'])
        .describe('Which lifecycle action to perform on the run.'),
      projectId: z.string(),
      taskId: z.string(),
      runId: z
        .string()
        .optional()
        .describe('Required for action=heartbeat and action=complete; omit for action=start.'),
      executorType: z.enum(['human', 'agent']).optional().describe('Required for action=start.'),
      executorName: z.string().optional().describe('Required for action=start.'),
      status: z.enum(['completed', 'failed']).optional().describe('Required for action=complete.'),
      outputSummary: z.string().optional(),
      filesChanged: z.array(z.string()).optional(),
      blockers: z.array(z.string()).optional(),
      driftSignals: z.array(z.string()).optional(),
      branchName: z.string().optional().describe('Git branch name where changes were committed.'),
      deliverablesMet: z
        .array(z.string())
        .optional()
        .describe(
          'Required when action=complete and status=completed. Will be AI-verified for agent executors.',
        ),
    },
    async (args) => {
      // Narrow with the discriminated union for precise per-action field
      // validation. The SDK's outer shape (above) keeps every field
      // optional so a single tool registration can advertise the union;
      // this safeParse is what actually enforces "no runId for start" /
      // "no executorName for heartbeat" / etc.
      const parsed = runArgsSchema.safeParse(args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new Error(`plansync_run: invalid arguments — ${issues}`);
      }
      const ctx = {
        api,
        onDrift: makeDriftCallback(server),
        toolName: 'plansync_run',
      };
      switch (parsed.data.action) {
        case 'start': {
          const { projectId, taskId, executorType, executorName } = parsed.data;
          return handleExecutionStart({ projectId, taskId, executorType, executorName }, ctx);
        }
        case 'heartbeat': {
          const { projectId, taskId, runId } = parsed.data;
          return handleExecutionHeartbeat({ projectId, taskId, runId }, ctx);
        }
        case 'complete': {
          const {
            projectId,
            taskId,
            runId,
            status,
            outputSummary,
            filesChanged,
            blockers,
            driftSignals,
            branchName,
            deliverablesMet,
          } = parsed.data;
          return handleExecutionComplete(
            {
              projectId,
              taskId,
              runId,
              status,
              outputSummary,
              filesChanged,
              blockers,
              driftSignals,
              branchName,
              deliverablesMet,
            },
            ctx,
          );
        }
      }
    },
  );
}

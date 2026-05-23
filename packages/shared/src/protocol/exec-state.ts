/**
 * Exec-mode protocol state machine (R-170).
 *
 * Today the contract between an LLM agent and the MCP server is *prose-encoded*
 * — i.e. `CLAUDE.md` describes "first call `plansync_exec_context`, then
 * `plansync_task_pack`, then `plansync_execution_start`, …", and the server
 * just trusts the agent to read and obey. If the agent skips a step (because
 * the prompt was truncated, because it's a generic MCP client without
 * `CLAUDE.md`, because the agent decided to ad-lib, …) the server happily
 * executes the out-of-order call. Drift v1 and the heartbeat scanner both have
 * scars from this: they routinely receive `execution_complete` for runs that
 * were never started, or `execution_start` after a competing run already
 * grabbed the task.
 *
 * R-170 fixes that by encoding the conversation as a finite state machine
 * **inside this package** so all four surfaces (`api`, `mcp-server`, `cli`,
 * `github-action`) share one canonical definition. R-171 is the follow-up
 * that wires the FSM into `tool-wrapper.ts` and starts rejecting illegal
 * transitions with an `OUT_OF_SEQUENCE` error. This module deliberately ships
 * the table + helpers first so R-171 can be a mechanical change rather than a
 * design exercise.
 *
 * Design notes:
 *   - The FSM is "pull-only": the server is the source of truth and stamps an
 *     opaque `stateToken` (an HMAC of the run identity + state + issuedAt) into
 *     every tool response so the next call must hand it back. Tokens are
 *     opaque to the agent — it just echoes what it received. This module only
 *     defines the **payload** shape that the server will sign; the actual
 *     `crypto.createHmac` lives next to `PLANSYNC_SECRET` handling, which is
 *     intentionally **not** in `@plansync/shared` (the shared package has no
 *     runtime deps beyond zod).
 *   - The transition table is keyed by canonical MCP tool name (without the
 *     `plansync_` prefix is tempting but we keep the prefix to match what the
 *     wire wire actually carries — easier to grep for).
 *   - "Soft" tools (`plansync_status`, comment reads, project list, …) are
 *     read-only and intentionally not state-gated; they're listed in
 *     `READ_ONLY_TOOLS` and the validator short-circuits to OK for them.
 *
 * Verification: this file is pure ESM, no I/O, no globals. Importable from any
 * package. See `tests/protocol/exec-state.test.ts` for the contract tests.
 */

import { z } from 'zod';

/** Canonical FSM states for an exec-mode session. */
export const EXEC_STATES = [
  'UNINITIALIZED',
  'CONTEXT_LOADED',
  'PACK_FETCHED',
  'RUN_STARTED',
  'COMPLETED',
  'ABORTED',
] as const;
export type ExecState = (typeof EXEC_STATES)[number];

/** Terminal states from which no further state-mutating tool may be called. */
export const TERMINAL_STATES: readonly ExecState[] = ['COMPLETED', 'ABORTED'] as const;

/**
 * Tools that are always allowed regardless of FSM state.
 *
 * These are *read-only* surfaces that don't change exec state on the server
 * side, so gating them would only create friction for agents that legitimately
 * want to check what's going on (e.g. before starting, after a drift signal).
 * Keep this list small and obvious — anything that writes belongs in the
 * gated table below.
 */
export const READ_ONLY_TOOLS: readonly string[] = [
  'plansync_status',
  'plansync_who',
  'plansync_project_list',
  'plansync_project_show',
  'plansync_member_list',
  'plansync_task_list',
  'plansync_task_show',
  'plansync_plan_list',
  'plansync_plan_show',
  'plansync_plan_active',
  'plansync_plan_diff',
  'plansync_activity_list',
  'plansync_my_work',
  'plansync_drift_list',
  'plansync_suggestion_list',
  'plansync_comment_list',
  'plansync_check_task_conflicts',
] as const;

/**
 * Description of one FSM node. Pure data so the API server, MCP wrapper, CLI
 * hint renderer and contract tests can all consume the same source.
 */
export interface ExecStateNode {
  /** Human-readable summary for `OUT_OF_SEQUENCE` error hints. */
  readonly description: string;

  /**
   * Tools that are accepted **while in this state** (read-only tools are
   * accepted unconditionally and not repeated here). The first transition
   * away from `UNINITIALIZED` is `plansync_exec_context`; in `CONTEXT_LOADED`
   * the agent must `plansync_task_pack` before it can do anything else; and
   * so on.
   */
  readonly allowedTools: readonly string[];

  /**
   * Tools the agent *must* call next, in priority order. The MCP wrapper
   * surfaces this as `OUT_OF_SEQUENCE.nextRequired` so a confused agent can
   * recover without re-reading the prose docs. Empty for terminal states.
   */
  readonly requiredNextOneOf: readonly string[];

  /**
   * Mapping from tool name → resulting state. A tool listed in
   * `allowedTools` but absent here keeps the state unchanged (e.g. you can
   * call `plansync_execution_heartbeat` many times without leaving
   * `RUN_STARTED`).
   */
  readonly transitions: Readonly<Record<string, ExecState>>;
}

/**
 * The full FSM table. Shape was vetted against the actual exec-mode flow in
 * `packages/mcp-server/src/index.ts` and `packages/mcp-server/src/tools/`.
 *
 * Edges:
 *   UNINITIALIZED  --exec_context-->        CONTEXT_LOADED
 *   CONTEXT_LOADED --task_pack-->           PACK_FETCHED
 *   PACK_FETCHED   --execution_start-->     RUN_STARTED
 *   RUN_STARTED    --execution_heartbeat--> RUN_STARTED   (self)
 *   RUN_STARTED    --execution_complete-->  COMPLETED
 *   RUN_STARTED    --execution_abort/abort/cancel--> ABORTED
 *
 * Drift-related rebinding (`plansync_drift_resolve`, `plansync_task_rebind`)
 * is allowed in `PACK_FETCHED` and `RUN_STARTED` and keeps the agent in the
 * same state — the *plan version* may have changed, but the FSM position
 * hasn't.
 */
export const EXEC_STATE_MACHINE: Readonly<Record<ExecState, ExecStateNode>> = {
  UNINITIALIZED: {
    description: 'No exec session yet — call plansync_exec_context first.',
    allowedTools: ['plansync_exec_context'],
    requiredNextOneOf: ['plansync_exec_context'],
    transitions: {
      plansync_exec_context: 'CONTEXT_LOADED',
    },
  },
  CONTEXT_LOADED: {
    description: 'Exec context loaded — call plansync_task_pack to receive the task brief.',
    allowedTools: ['plansync_task_pack', 'plansync_exec_context'],
    requiredNextOneOf: ['plansync_task_pack'],
    transitions: {
      plansync_task_pack: 'PACK_FETCHED',
    },
  },
  PACK_FETCHED: {
    description:
      'Task pack received — resolve any drift alerts and then call plansync_execution_start.',
    allowedTools: [
      'plansync_task_pack',
      'plansync_execution_start',
      'plansync_drift_resolve',
      'plansync_task_rebind',
      'plansync_comment_create',
      'plansync_plan_suggest',
    ],
    requiredNextOneOf: ['plansync_execution_start'],
    transitions: {
      plansync_execution_start: 'RUN_STARTED',
    },
  },
  RUN_STARTED: {
    description:
      'Execution running — heartbeat, then call plansync_execution_complete (or abort) when done.',
    allowedTools: [
      'plansync_execution_heartbeat',
      'plansync_execution_complete',
      'plansync_execution_abort',
      'plansync_drift_resolve',
      'plansync_task_rebind',
      'plansync_comment_create',
      'plansync_plan_suggest',
    ],
    requiredNextOneOf: ['plansync_execution_heartbeat', 'plansync_execution_complete'],
    transitions: {
      plansync_execution_complete: 'COMPLETED',
      plansync_execution_abort: 'ABORTED',
    },
  },
  COMPLETED: {
    description: 'Run completed — open a new exec_context for the next task.',
    allowedTools: [],
    requiredNextOneOf: [],
    transitions: {},
  },
  ABORTED: {
    description: 'Run aborted — open a new exec_context for the next task.',
    allowedTools: [],
    requiredNextOneOf: [],
    transitions: {},
  },
} as const;

/**
 * Result of attempting a tool call from a given state.
 *
 * The MCP wrapper turns the `OUT_OF_SEQUENCE` variant into a structured tool
 * error so the LLM can self-correct without re-reading `CLAUDE.md`.
 */
export type TransitionResult =
  | { ok: true; nextState: ExecState; readOnly: boolean }
  | {
      ok: false;
      error: 'OUT_OF_SEQUENCE';
      message: string;
      currentState: ExecState;
      allowedTools: readonly string[];
      requiredNextOneOf: readonly string[];
    };

/** Sentinel returned in `OUT_OF_SEQUENCE` errors and surfaced on the wire. */
export const OUT_OF_SEQUENCE = 'OUT_OF_SEQUENCE' as const;

/**
 * Pure validator: given the current FSM state and a tool name, returns either
 * `{ ok: true, nextState }` or `{ ok: false, error: 'OUT_OF_SEQUENCE', … }`.
 *
 * Read-only tools (see `READ_ONLY_TOOLS`) always succeed and leave the state
 * unchanged. Calls from terminal states (COMPLETED / ABORTED) are always
 * rejected unless they're read-only.
 */
export function checkTransition(currentState: ExecState, toolName: string): TransitionResult {
  if (READ_ONLY_TOOLS.includes(toolName)) {
    return { ok: true, nextState: currentState, readOnly: true };
  }
  const node = EXEC_STATE_MACHINE[currentState];
  if (!node.allowedTools.includes(toolName)) {
    return {
      ok: false,
      error: OUT_OF_SEQUENCE,
      message:
        `Tool '${toolName}' is not allowed from state '${currentState}'. ` + node.description,
      currentState,
      allowedTools: node.allowedTools,
      requiredNextOneOf: node.requiredNextOneOf,
    };
  }
  const nextState = node.transitions[toolName] ?? currentState;
  return { ok: true, nextState, readOnly: false };
}

/**
 * Convenience wrapper for code that just wants the next state and is happy to
 * throw if the transition is illegal. The server-side wrapper uses
 * `checkTransition` directly so it can return a structured error.
 */
export function nextStateForTool(currentState: ExecState, toolName: string): ExecState {
  const result = checkTransition(currentState, toolName);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.nextState;
}

/**
 * Shape of the payload that the server signs into the `stateToken`.
 *
 * The token itself is `base64url(JSON(payload)) + '.' + base64url(hmacSHA256(secret, JSON(payload)))`,
 * which keeps it opaque to the agent (it just echoes what it got) but lets
 * the server verify integrity + freshness without per-session storage. The
 * actual sign / verify lives in `packages/api/src/lib/exec-state-token.ts`
 * (added in R-171); this package only owns the payload contract so all
 * surfaces type-check against the same source.
 */
export const execStateTokenPayloadSchema = z.object({
  /** Tagged so we can rotate the payload schema later without colliding. */
  v: z.literal(1),
  /** The execution run this token is bound to. */
  runId: z.string().min(1),
  /** The project the run belongs to (used for scoping in R-011/R-137). */
  projectId: z.string().min(1),
  /** Current FSM state. */
  state: z.enum(EXEC_STATES),
  /** ms since epoch when the token was issued. */
  issuedAt: z.number().int().nonnegative(),
  /** Optional task id for diagnostic / logging purposes. */
  taskId: z.string().min(1).optional(),
});
export type ExecStateTokenPayload = z.infer<typeof execStateTokenPayloadSchema>;

/**
 * Max age the server should accept for a `stateToken` before forcing the agent
 * to re-fetch (e.g. by reissuing through `plansync_exec_context`). Long enough
 * to span a normal task; short enough that a leaked token is bounded.
 */
export const EXEC_STATE_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * True if `state` cannot transition further (COMPLETED or ABORTED).
 */
export function isTerminalState(state: ExecState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * Helper: list every tool name that ever appears in the FSM table. Used by
 * the contract test that asserts the table matches the live MCP surface.
 */
export function listGatedTools(): readonly string[] {
  const set = new Set<string>();
  for (const node of Object.values(EXEC_STATE_MACHINE)) {
    for (const t of node.allowedTools) set.add(t);
  }
  return [...set].sort();
}

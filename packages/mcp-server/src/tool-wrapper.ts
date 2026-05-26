/**
 * Centralised wrapper around `server.tool` registrations.
 *
 * Three responsibilities, in order of evaluation per tool call:
 *
 *   1. Drop tools that aren't in `EXEC_ALLOWED` when the server boots in
 *      execution mode (skip registration entirely — invisible to the AI).
 *   2. Short-circuit every call when the run has been aborted by the API
 *      (drift v2). The handler returns a structured `RUN_ABORTED` envelope.
 *   3. Short-circuit every call when delegation mode is active but the tool
 *      isn't in `DELEGATION_ALLOWED`. Returns a structured `DELEGATION_BLOCKED`
 *      envelope.
 *   4. **R-037**: wrap the handler in try/catch and translate any thrown
 *      error (typically `ApiError` from `api-client.ts`) into a uniform
 *      `{ isError: true, content: [...] }` envelope so MCP clients can
 *      reliably detect failure without parsing free-form text.
 *
 * Extracted from `index.ts` so the error-translation logic can be unit
 * tested without booting the SDK.
 */
import { ApiError } from './api-client';
import { isRunAborted, RunAbortReason } from './abort-signal';
import { logger } from './logger';
import { normalizeRunToolNameForFsm } from './tools/run';

export interface ToolErrorEnvelope {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
}

export interface ToolDelegationEnvelope {
  content: Array<{ type: 'text'; text: string }>;
}

export interface ToolWrapperOptions {
  /** When set, only tools in this set are registered; others are silently skipped. */
  execAllowed?: Set<string>;
  /** When set, tools NOT in this set return `DELEGATION_BLOCKED` while delegation is active. */
  delegationAllowed: Set<string>;
  /** Returns the active delegation agent name, or undefined when not delegating. */
  getDelegationAgent: () => string | undefined;
  /** Returns the current run-abort reason, or null when the run is healthy. */
  getRunAbortReason?: () => RunAbortReason | null;
}

/**
 * Build the abort envelope returned by every tool once the run is aborted.
 * Exported so tests can compare against the canonical shape.
 */
export function buildAbortEnvelope(reason: RunAbortReason): ToolErrorEnvelope {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: {
            code: 'RUN_ABORTED',
            abortCode: reason.code,
            message: reason.message,
            runId: reason.runId,
            taskId: reason.taskId,
            guidance:
              'This execution has been aborted by the API (drift v2). Do NOT call any more PlanSync tools. Stop the ai-loop, report the abort to the user, and let them decide next steps (rebind, cancel, or start a fresh execution after drift is resolved).',
          },
        }),
      },
    ],
  };
}

/**
 * Build the delegation envelope used when the active delegation agent tries
 * to call a tool that isn't in DELEGATION_ALLOWED.
 *
 * Note: this envelope intentionally omits `isError: true` because the call
 * was *not* an internal failure — it's a deliberate policy block that the
 * AI should observe and route around (typically by calling
 * `plansync_plan_suggest` or `plansync_delegation_clear`).
 */
export function buildDelegationEnvelope(
  agentName: string,
  toolName: string,
): ToolDelegationEnvelope {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: 'DELEGATION_BLOCKED',
          message: `Delegation mode active (as: "${agentName}") — "${toolName}" is blocked. Use plansync_plan_suggest to propose changes, or call plansync_delegation_clear first.`,
        }),
      },
    ],
  };
}

/**
 * Translate any thrown error into the uniform `isError` envelope. ApiError
 * objects expose their wire-level `code` / `status` / `details`; everything
 * else falls back to `INTERNAL` so clients have a stable code to switch on.
 *
 * R-037 — this is the central piece. Tool handlers should `throw` rather
 * than try to format their own error envelopes; this wrapper handles the
 * translation so every PlanSync tool produces the same shape on failure.
 */
export function buildErrorEnvelope(err: unknown, toolName: string): ToolErrorEnvelope {
  if (err instanceof ApiError) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: {
              code: err.code,
              message: err.message,
              status: err.status,
              details: err.details,
              tool: toolName,
            },
          }),
        },
      ],
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error({ err, tool: toolName, stack }, 'MCP tool handler threw non-ApiError');

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: {
            code: 'INTERNAL',
            message,
            tool: toolName,
          },
        }),
      },
    ],
  };
}

/** Result of running the pre-flight checks for a single tool invocation. */
type PreflightResult =
  | { kind: 'allow' }
  | {
      kind: 'short-circuit';
      response: ToolErrorEnvelope | ToolDelegationEnvelope | OutOfSequenceEnvelope;
    };

/**
 * R-142 rollback flag — `PLANSYNC_MCP_LEGACY_ABORT=true` reverts to the
 * pre-R-142 behaviour where an aborted run only emits a
 * `sendLoggingMessage` notification and subsequent tool calls are still
 * dispatched normally. Generic MCP clients that render
 * `notifications/message` as chat will treat the abort as a soft hint and
 * keep going, which is the exact bug R-142 fixes. The flag exists purely
 * as an emergency escape hatch and is OFF by default.
 *
 * Exported so tests can pin the parsing without poking at the env var
 * directly.
 */
export function isLegacyAbortEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PLANSYNC_MCP_LEGACY_ABORT;
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/**
 * Pre-flight checks run before every tool handler invocation. Exported for
 * tests; the production wrapper composes this with the handler call + the
 * error translator.
 *
 * Order matters:
 *   1. RUN_ABORTED — once the API kills the run, every subsequent call
 *      must be rejected uniformly regardless of FSM state. Unless the
 *      `PLANSYNC_MCP_LEGACY_ABORT` rollback flag is set, in which case we
 *      skip the gate and let the call through (legacy behaviour).
 *   2. DELEGATION_BLOCKED — operator policy gate runs before FSM gating
 *      so a delegated agent gets the same explanation it would get
 *      outside exec mode.
 *   3. OUT_OF_SEQUENCE (R-171) — FSM check. May only reject in `enforce`
 *      mode; in `shadow` mode it logs + allows, in `off` mode it tracks
 *      state silently. See `ExecStateManager.recordToolCall`.
 */
export function evaluatePreflight(
  toolName: string,
  options: ToolWrapperOptions,
  fsmToolName?: string,
): PreflightResult {
  const getAbort = options.getRunAbortReason ?? isRunAborted;
  const abort = getAbort();
  if (abort && !isLegacyAbortEnabled()) {
    return { kind: 'short-circuit', response: buildAbortEnvelope(abort) };
  }

  const delegationAgent = options.getDelegationAgent();
  if (delegationAgent && !options.delegationAllowed.has(toolName)) {
    return {
      kind: 'short-circuit',
      response: buildDelegationEnvelope(delegationAgent, toolName),
    };
  }

  if (options.execStateManager) {
    // R-204 — `fsmToolName` is the legacy `plansync_execution_*` name when
    // the actual call was a `plansync_run({action:..., ...})` invocation,
    // so the FSM table (which still keys on the legacy names) stays
    // untouched during the deprecation cycle.
    const fsmResult = options.execStateManager.recordToolCall(toolName, fsmToolName);
    if (!fsmResult.ok) {
      return { kind: 'short-circuit', response: fsmResult.envelope };
    }
  }

  return { kind: 'allow' };
}

/**
 * Wrap a raw tool handler with preflight checks + error translation. Used
 * by both production code (via `patchServerToolRegistration`) and tests.
 */
/**
 * R6b / closes #997 — a handler that doesn't throw but returns an
 * MCP error envelope (`{ isError: true, content: [...] }`) is just
 * as much a failure as a thrown exception. We have to roll back the
 * FSM in BOTH cases, otherwise a handler that catches its own DB
 * error and returns `{ isError: true, content: [...] }` leaves the
 * agent stuck in the advanced state with no recovery path.
 *
 * The shape check is intentionally loose: we treat anything with a
 * truthy `.isError` as a failure. Tool handlers in this codebase that
 * succeed never set `.isError`, so false positives are not a concern.
 */
function isErrorEnvelopeReturn(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return (value as { isError?: unknown }).isError === true;
}

export function wrapToolHandler<TArgs, TResult>(
  toolName: string,
  handler: (args: TArgs) => Promise<TResult> | TResult,
  options: ToolWrapperOptions,
): (args: TArgs) => Promise<TResult | ToolErrorEnvelope | ToolDelegationEnvelope> {
  return async (args: TArgs) => {
    // R6 / closes #923: capture the FSM state BEFORE preflight so we
    // can roll back if the handler throws. Pre-fix, evaluatePreflight
    // (via recordToolCall) advanced the FSM eagerly; a thrown handler
    // then left the agent stuck in a "completed" state that no longer
    // permitted the recovery tool calls.
    const preFsmState = options.execStateManager?.getState();
    // R-204 — translate `plansync_run(action, ...)` into the legacy
    // `plansync_execution_*` name the FSM table still keys on. No-op
    // for any other tool.
    const fsmToolName = normalizeRunToolNameForFsm(toolName, args);
    const preflight = evaluatePreflight(toolName, options, fsmToolName);
    if (preflight.kind === 'short-circuit') {
      return preflight.response;
    }
    try {
      const result = await handler(args);
      // R6b / closes #997 — also roll back when the handler returned
      // an isError envelope rather than throwing. This is the common
      // pattern for tool handlers that catch their own DB / API
      // failures and surface a structured error to the agent.
      if (isErrorEnvelopeReturn(result) && preFsmState !== undefined && options.execStateManager) {
        options.execStateManager.rollbackTo(preFsmState);
      }
      return result;
    } catch (err) {
      if (preFsmState !== undefined && options.execStateManager) {
        options.execStateManager.rollbackTo(preFsmState);
      }
      return buildErrorEnvelope(err, toolName);
    }
  };
}

/**
 * Minimal shape of the MCP server we need to patch. Kept loose so we don't
 * couple to the SDK's type recursion (see R-132 — the SDK's generics OOM
 * tsc, which is why mcp-server typecheck is currently disabled).
 */
interface PatchableServer {
  tool: (...args: unknown[]) => unknown;
}

/**
 * Patch `server.tool` so every subsequently-registered tool runs through
 * `wrapToolHandler`. Tools whose name isn't in `options.execAllowed` (when
 * provided) are silently skipped — they won't appear in the AI's tool
 * list at all, which matches the "exec mode invisible" contract documented
 * in CLAUDE.md.
 */
export function patchServerToolRegistration(
  server: PatchableServer,
  options: ToolWrapperOptions,
): void {
  const original = server.tool.bind(server) as (...args: unknown[]) => unknown;
  server.tool = function patchedTool(name: unknown, ...rest: unknown[]) {
    if (typeof name !== 'string') return original(name as never, ...(rest as never[]));

    if (options.execAllowed && !options.execAllowed.has(name)) {
      // Drop the registration entirely. The SDK never advertises the tool,
      // so the AI cannot call it — matches the EXEC_ALLOWED contract.
      return undefined;
    }

    if (rest.length === 0) {
      return original(name, ...rest);
    }
    const originalHandler = rest[rest.length - 1] as (args: unknown) => unknown;
    if (typeof originalHandler !== 'function') {
      return original(name, ...rest);
    }
    rest[rest.length - 1] = wrapToolHandler(
      name,
      originalHandler as (a: unknown) => unknown,
      options,
    );
    return original(name, ...rest);
  } as unknown as PatchableServer['tool'];
}

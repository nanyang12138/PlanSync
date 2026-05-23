/**
 * Per-session exec-state manager (R-171).
 *
 * One MCP server process corresponds to one stdio session corresponds to
 * one agent conversation, so we track the FSM state in process-local state
 * here. The `recordToolCall` method is the single entry point used by
 * `tool-wrapper.ts`:
 *
 *   1. read-only tools (in `READ_ONLY_TOOLS`) always succeed and don't
 *      advance state — `{ ok: true, advanced: false }`
 *   2. legal transition → advance + return `{ ok: true, advanced: true, newToken }`
 *   3. illegal transition + `enforce` mode → `{ ok: false, envelope }`
 *      where envelope is the `OUT_OF_SEQUENCE` shape from `docs/PROTOCOL.md`
 *   4. illegal transition + `shadow` mode → log warn, return `{ ok: true,
 *      advanced: false, shadowViolation: true }` so the call still goes
 *      through but ops can grep for the warning
 *   5. illegal transition + `off` mode → silent allow (current behaviour)
 *
 * The stateToken returned by `recordToolCall` is opaque to the agent — the
 * MCP server signs it with `PLANSYNC_SECRET` (via `signExecStateToken`) so
 * downstream consumers (a future R-191 web hook handler, or a separate API
 * route called outside the MCP session) can verify the agent didn't fabricate
 * the state. Verification is done by `verifyToken` here for incoming requests
 * but the MCP server itself currently trusts its own in-process state — the
 * token is the audit / cross-process integrity story, not the primary gate.
 *
 * Rollout flag `PLANSYNC_EXEC_STATE_ENFORCE` (off|shadow|enforce, default off):
 *   - off:     no-op. Manager records state but never blocks. Suitable for
 *              the initial production rollout while we confirm the FSM table
 *              matches every agent in the wild.
 *   - shadow:  illegal transitions logged at WARN with structured payload
 *              (`{tool, from, currentState, expectedNext}`). Call proceeds.
 *              Use this for ~1 week to surface false positives before
 *              flipping to enforce.
 *   - enforce: illegal transitions short-circuit with the OUT_OF_SEQUENCE
 *              envelope. The handler is never invoked.
 *
 * Lifecycle:
 *   - one manager per `McpServer` instance (created in `index.ts`)
 *   - resets to `UNINITIALIZED` on construction
 *   - `recordToolCall('plansync_exec_context')` moves to CONTEXT_LOADED
 *   - terminal states (COMPLETED / ABORTED) reject all subsequent
 *     non-read-only calls regardless of enforce mode (those tools are not
 *     in `allowedTools` for terminal nodes, so the FSM rejection fires)
 *
 * The manager is intentionally NOT a singleton — tests instantiate fresh
 * managers and `index.ts` wires the production one through.
 */
import {
  EXEC_STATE_MACHINE,
  READ_ONLY_TOOLS,
  checkTransition,
  type ExecState,
} from '@plansync/shared';
import { logger } from './logger';
import { signExecStateToken, verifyExecStateToken } from './exec-state-token';

export type EnforceMode = 'off' | 'shadow' | 'enforce';

/**
 * Read enforcement mode from env, with bounded validation. Anything other
 * than the three legal values defaults to `off` so a typo doesn't
 * accidentally activate enforcement in production.
 */
export function readEnforceMode(env: NodeJS.ProcessEnv = process.env): EnforceMode {
  const v = (env.PLANSYNC_EXEC_STATE_ENFORCE ?? 'off').toLowerCase().trim();
  if (v === 'shadow' || v === 'enforce') return v;
  return 'off';
}

export interface RecordOk {
  ok: true;
  advanced: boolean;
  /** New FSM state after this call (unchanged if `advanced=false`). */
  state: ExecState;
  /**
   * Signed token reflecting the new state. Always returned when the
   * manager has a secret + a non-empty `runId`; otherwise undefined.
   * Tool handlers attach it to the response envelope for the agent to
   * echo back on the next call (R-191 / future cross-process verify).
   */
  newToken?: string;
  /** True when shadow mode swallowed an illegal transition. */
  shadowViolation?: boolean;
}

export interface OutOfSequenceEnvelope {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
}

export interface RecordReject {
  ok: false;
  envelope: OutOfSequenceEnvelope;
  state: ExecState;
}

export type RecordResult = RecordOk | RecordReject;

export interface ExecStateManagerOptions {
  /** PLANSYNC_SECRET — required to mint signed tokens. If absent, the
   *  manager still tracks state but `newToken` is always undefined. */
  secret?: string;
  /** Optional override for testing; defaults to env. */
  enforceMode?: EnforceMode;
  /** runId binds the token. Set when `plansync_exec_context` returns a
   *  registered run (exec mode) or when `plansync_execution_start` succeeds. */
  runId?: string;
  /** projectId binds the token (matches `ExecStateTokenPayload.projectId`). */
  projectId?: string;
  /** taskId — diagnostic / logging field on the token. */
  taskId?: string;
  /** Injected clock for deterministic tests. */
  nowMs?: () => number;
}

/** Build the canonical OUT_OF_SEQUENCE envelope (matches docs/PROTOCOL.md). */
export function buildOutOfSequenceEnvelope(
  toolName: string,
  currentState: ExecState,
): OutOfSequenceEnvelope {
  const node = EXEC_STATE_MACHINE[currentState];
  const payload = {
    error: {
      code: 'OUT_OF_SEQUENCE',
      message: `Tool '${toolName}' is not allowed from state '${currentState}'. ${node.description}`,
      currentState,
      allowedTools: node.allowedTools,
      requiredNextOneOf: node.requiredNextOneOf,
      hint:
        node.requiredNextOneOf.length > 0
          ? `Call '${node.requiredNextOneOf[0]}' next.`
          : 'This state is terminal — open a new exec_context to start a fresh session.',
    },
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

export class ExecStateManager {
  private state: ExecState = 'UNINITIALIZED';
  private readonly secret?: string;
  private enforceMode: EnforceMode;
  private runId?: string;
  private projectId?: string;
  private taskId?: string;
  private now: () => number;

  constructor(options: ExecStateManagerOptions = {}) {
    this.secret = options.secret;
    this.enforceMode = options.enforceMode ?? readEnforceMode();
    this.runId = options.runId;
    this.projectId = options.projectId;
    this.taskId = options.taskId;
    this.now = options.nowMs ?? (() => Date.now());
  }

  /** Current FSM state — exposed for diagnostics + tests. */
  getState(): ExecState {
    return this.state;
  }

  getEnforceMode(): EnforceMode {
    return this.enforceMode;
  }

  /** Bind / re-bind the run identity. Called once `exec_context` or
   *  `execution_start` returns a runId. */
  bindRun(opts: { runId: string; projectId: string; taskId?: string }): void {
    this.runId = opts.runId;
    this.projectId = opts.projectId;
    if (opts.taskId !== undefined) this.taskId = opts.taskId;
  }

  /**
   * Verify a token the agent passed in. Returns the verified payload on
   * success, or null on any failure (caller decides how to react — the MCP
   * server currently uses its own in-process state as source of truth and
   * only logs token mismatches).
   */
  verifyToken(token: string | undefined): ReturnType<typeof verifyExecStateToken> | null {
    if (!token || !this.secret) return null;
    return verifyExecStateToken(token, this.secret, this.now());
  }

  /**
   * Record a tool call attempt. Returns either an allow (with optional new
   * token) or a structured OUT_OF_SEQUENCE envelope for enforce mode.
   *
   * This is the single hot-path entry point — keep it cheap.
   */
  recordToolCall(toolName: string): RecordResult {
    if (READ_ONLY_TOOLS.includes(toolName)) {
      // Read-only never advances state and never errors. No new token —
      // there's nothing for the agent to round-trip.
      return { ok: true, advanced: false, state: this.state };
    }
    const result = checkTransition(this.state, toolName);
    if (!result.ok) {
      // Illegal transition.
      if (this.enforceMode === 'enforce') {
        logger.warn(
          {
            tool: toolName,
            from: this.state,
            allowed: result.allowedTools,
            expectedNext: result.requiredNextOneOf,
            mode: 'enforce',
          },
          'R-171 OUT_OF_SEQUENCE — rejecting tool call',
        );
        return {
          ok: false,
          envelope: buildOutOfSequenceEnvelope(toolName, this.state),
          state: this.state,
        };
      }
      if (this.enforceMode === 'shadow') {
        logger.warn(
          {
            tool: toolName,
            from: this.state,
            allowed: result.allowedTools,
            expectedNext: result.requiredNextOneOf,
            mode: 'shadow',
          },
          'R-171 OUT_OF_SEQUENCE — shadow mode (allowing call)',
        );
        return { ok: true, advanced: false, state: this.state, shadowViolation: true };
      }
      // 'off' — completely silent, but still don't advance state from an
      // illegal transition (otherwise enforce-mode-later breaks).
      return { ok: true, advanced: false, state: this.state };
    }
    // Legal transition — advance.
    const advanced = result.nextState !== this.state;
    this.state = result.nextState;
    return {
      ok: true,
      advanced,
      state: this.state,
      newToken: this.maybeMintToken(),
    };
  }

  /** Mint a fresh token if we have the bits we need; returns undefined
   *  otherwise so callers can omit the field. */
  private maybeMintToken(): string | undefined {
    if (!this.secret || !this.runId || !this.projectId) return undefined;
    return signExecStateToken(
      {
        v: 1,
        runId: this.runId,
        projectId: this.projectId,
        state: this.state,
        issuedAt: this.now(),
        ...(this.taskId ? { taskId: this.taskId } : {}),
      },
      this.secret,
    );
  }
}

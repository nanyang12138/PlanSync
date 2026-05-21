/**
 * Cross-module abort signal for the MCP server process.
 *
 * Drift v2 defense-in-depth: when the API tells us a run has been forcibly
 * moved out of running (paused, stale-version) the agent's ai-loop should
 * stop at the very next tool call rather than wait for the next 30-second
 * heartbeat OR a best-effort SSE push to arrive. The heartbeat handler in
 * tools/execution.ts calls `signalRunAborted()` the moment it sees one of
 * the relevant 409 codes; the tool wrapper in index.ts checks
 * `isRunAborted()` before every tool invocation and short-circuits with a
 * structured error if set; the CLI mcp-client surfaces the abort
 * notification so the ai-loop can flip its AbortController.
 *
 * The abort is process-local: one MCP server instance backs one agent
 * session, so a process-level flag is the right scope. If we ever multiplex
 * runs in one process, this becomes a `Map<runId, AbortState>` and the
 * call sites pass `runId`.
 */
import { logger } from './logger';

export interface RunAbortReason {
  /** Stable enum string. Matches the API's error.details.code where applicable. */
  code: 'RUN_PAUSED' | 'RUN_STALE_VERSION' | 'RUN_RACE_LOST' | 'MANUAL';
  /** Human-readable explanation, safe to echo to the LLM. */
  message: string;
  /** Optional run/task/plan context for telemetry. */
  runId?: string;
  taskId?: string;
  runBoundPlanVersion?: number;
  taskBoundPlanVersion?: number;
}

let aborted: RunAbortReason | null = null;
const listeners = new Set<(reason: RunAbortReason) => void>();

/**
 * Idempotent — first abort wins; subsequent calls are logged (debug) and
 * dropped. Listeners fire exactly once per process lifetime so the CLI
 * doesn't see duplicate "aborted" notifications.
 */
export function signalRunAborted(reason: RunAbortReason): void {
  if (aborted) {
    logger.debug({ existing: aborted, incoming: reason }, 'Abort already set; ignoring re-trigger');
    return;
  }
  aborted = reason;
  logger.warn({ reason }, 'MCP server run aborted');
  for (const fn of Array.from(listeners)) {
    try {
      fn(reason);
    } catch (err) {
      logger.warn({ err }, 'Abort listener threw');
    }
  }
}

export function isRunAborted(): RunAbortReason | null {
  return aborted;
}

export function onRunAborted(fn: (reason: RunAbortReason) => void): () => void {
  listeners.add(fn);
  if (aborted) {
    // late subscriber still sees the latched state immediately
    Promise.resolve().then(() => fn(aborted!));
  }
  return () => listeners.delete(fn);
}

/**
 * Test-only — reset the latched state and clear listeners. Production code
 * must not call this; the abort is intentionally one-shot.
 */
export function _resetRunAbortedForTests(): void {
  aborted = null;
  listeners.clear();
}

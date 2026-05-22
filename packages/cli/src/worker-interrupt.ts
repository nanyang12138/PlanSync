/**
 * R-071 — `/worker` Ctrl+C 中断子进程.
 *
 * The worker loop in `runSlashCommand` registers a SIGINT handler so the user
 * can stop the polling cycle without killing the whole CLI. The original
 * implementation hung the handler off `rawInput.onSigint`, but the worker
 * calls `rawInput.pause()` first — once stdin is paused no keypress events
 * (including Ctrl+C) reach the readline layer, so the handler never fired
 * and an in-flight `launchAutoExec` child was allowed to finish naturally
 * while the worker loop continued to the next task on the next poll tick.
 *
 * The fix:
 *   1. Register a process-level SIGINT handler (paused stdin doesn't matter
 *      for process signals).
 *   2. Track the live Genie child via `launchAutoExec`'s `onChildSpawned`
 *      callback so the handler can forward `SIGINT` to it directly. This is
 *      belt-and-suspenders next to the launcher's own internal cleanup; it
 *      also means the worker doesn't depend on the launcher's signal
 *      bookkeeping staying consistent across refactors.
 *
 * The state-machine pieces live here as a tiny pure helper so the test suite
 * can exercise them without spinning up a real subprocess or mounting Ink.
 */

/**
 * Subset of `ChildProcess` the worker actually needs. Keeping it minimal
 * makes the helper trivially mockable in tests.
 */
export interface WorkerChildHandle {
  kill: (signal?: NodeJS.Signals | number) => boolean;
}

export interface WorkerInterruptOptions {
  /** Called to flip the worker's `stopWorker` flag. */
  setStop: () => void;
  /** Returns the currently-running Genie child, or `null` between tasks. */
  getChild: () => WorkerChildHandle | null;
  /**
   * Optional user-facing message. Defaults to a hard-coded English string;
   * callers may wrap it in colour codes.
   */
  logger?: (msg: string) => void;
  /**
   * Signal to forward to the child. Defaults to `SIGINT` so the child can do
   * its own graceful shutdown (matches what `launchAutoExec` does internally).
   */
  signal?: NodeJS.Signals;
}

/**
 * Builds the SIGINT handler used by the `/worker` loop.
 *
 * Behaviour:
 *  - Always calls `setStop()` first so the loop will exit after the current
 *    task, even if `child.kill` throws (e.g. the PID is already gone and the
 *    runtime reports ESRCH as a thrown error rather than `false`).
 *  - Logs a single message so the user sees feedback even before the child
 *    process has unwound.
 *  - Forwards the signal to the live child if there is one. Errors from
 *    `child.kill` are swallowed — by the time we get here the child may
 *    already have exited and the kernel will reject the signal; that's not a
 *    user-actionable problem.
 */
export function createWorkerInterruptHandler(opts: WorkerInterruptOptions): () => void {
  const signal: NodeJS.Signals = opts.signal ?? 'SIGINT';
  return () => {
    opts.setStop();
    if (opts.logger) opts.logger('⚠ Worker stopping after current task...');
    const child = opts.getChild();
    if (!child) return;
    try {
      child.kill(signal);
    } catch {
      /* child already exited — nothing to do */
    }
  };
}

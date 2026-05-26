import { spawn, ChildProcess } from 'child_process';
import { cfg } from './config.js';
import { c } from './ui.js';

export interface ExecutionAbortReason {
  code: string;
  message: string;
  runId?: string;
  taskId?: string;
}

/**
 * R-021: max consecutive spawn failures before `isHealthy()` returns false.
 * The user is expected to take manual action (restart CLI, check logs) once
 * we cross this threshold. We do not give up trying — `ensureRunning()` will
 * keep attempting — but other code paths can use `isHealthy()` as a signal
 * to stop calling tools / show a banner to the user.
 */
const MAX_CONSECUTIVE_CRASHES = 3;

/**
 * R-021: exponential backoff schedule for restart attempts in `ensureRunning`.
 * The values cap intentionally low so an interactive CLI does not feel laggy
 * when the MCP server is genuinely down (the user gets feedback quickly).
 */
const RESTART_BACKOFF_MS = [0, 250, 750];

/**
 * Cap on how many recent output lines from the MCP child are retained for
 * surfacing on a crash. The MCP server uses pino on stdout, so a single
 * structured log line can be ~1 KB; 50 lines × ~1 KB = ~50 KB upper bound,
 * which is small enough to keep in memory indefinitely yet plenty for
 * humans to read on the terminal when something goes wrong.
 */
const CHILD_OUTPUT_RING_LINES = 50;
/** Per-line cap so a runaway log line cannot blow memory. */
const CHILD_OUTPUT_LINE_CAP = 4096;
/**
 * Cap on the partial-line stdout buffer that holds bytes between
 * newline boundaries. A LEGITIMATE MCP JSON-RPC response is one
 * newline-delimited frame, and frames the size of an inflated
 * `task_pack` (deliverable bodies + plan diff + drift alerts on a
 * mature project) can comfortably reach a few hundred kilobytes.
 *
 * Pre-fix this used `CHILD_OUTPUT_LINE_CAP` (4 KiB), which forced
 * the partial buffer to be force-flushed as a diagnostic line and
 * the rest of the legitimate frame to be parsed as garbage —
 * `request timed out` / `tool result lost` were the visible
 * symptoms (closes #871 / #913).
 *
 * 16 MiB is the same upper bound Node uses by default for outgoing
 * HTTP bodies and is plenty for any single MCP frame. Anything
 * past it is almost certainly a runaway / malicious child stream
 * — we still drop the partial buffer and surface a diagnostic so
 * the bug is visible rather than silently OOMing the CLI.
 */
const CHILD_STDOUT_PARTIAL_BUFFER_CAP = 16 * 1024 * 1024;

export class McpClient {
  private proc: ChildProcess | null = null;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private reqId = 0;
  private tools: unknown[] = [];
  private readBuffer = '';
  private notifyPrinter: ((text: string) => void) | null = null;
  private abortHandler: ((reason: ExecutionAbortReason) => void) | null = null;
  /** R-021: counts unexpected process exits since the last successful start. */
  private consecutiveCrashes = 0;
  /** R-021: set true by stop() so we don't treat user-initiated shutdown as a crash. */
  private intentionalShutdown = false;
  /** Override of the sleep used between restart attempts; tests inject a no-op. */
  private sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
  /**
   * R-022: remember the path passed to start() so callTool can transparently
   * call ensureRunning() on transport failures without pushing the path back
   * up to every caller site.
   */
  private serverPath: string | null = null;

  /**
   * Ring buffer of recent output lines from the MCP child (both stderr and
   * non-protocol stdout lines). When the subprocess crashes during startup
   * we emit these to the user so they get an actionable repro instead of
   * an opaque "subprocess exited (code 1)".
   *
   * Why both streams: pino — the MCP server's logger — defaults to stdout.
   * A startup error like the R-040 "PLANSYNC_API_KEY is not set" or the
   * R-171 "ReferenceError: readEnforceMode is not defined" is emitted as a
   * structured pino JSON line on stdout that does NOT match a JSON-RPC
   * id / method, so we recognise that case and route those orphan lines
   * into this ring. Plain text on stderr (Node fatal error traces, etc.)
   * is captured directly.
   */
  private childOutputLines: string[] = [];
  /** Partial-line accumulator for stderr (chunks may not align with newlines). */
  private stderrAccumulator = '';

  setNotifyPrinter(fn: (text: string) => void): void {
    this.notifyPrinter = fn;
  }

  /**
   * Drift v2 (S6): subscribe to `execution_aborted` notifications pushed by
   * the MCP server when the API has forcibly moved the run out of running
   * (paused, stale-version, race-lost). The handler is expected to fire a
   * local AbortController so the ai-loop exits at the next turn boundary.
   * Defense in depth: even if SSE drops, the next MCP tool call will
   * short-circuit with `error.code === 'RUN_ABORTED'` from the server's
   * tool wrapper, so the agent stops either way.
   */
  setAbortHandler(fn: (reason: ExecutionAbortReason) => void): void {
    this.abortHandler = fn;
  }

  /**
   * Test-only seam: replace the sleep used in `ensureRunning` so the
   * exponential-backoff retry loop completes instantly during unit tests.
   * Not exposed via any public API surface that real callers depend on.
   */
  _setSleepFnForTests(fn: (ms: number) => Promise<void>): void {
    this.sleepFn = fn;
  }

  async start(serverPath: string): Promise<void> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PLANSYNC_API_URL: cfg.apiUrl,
      PLANSYNC_API_KEY: cfg.apiKey,
      PLANSYNC_USER: cfg.user,
      PLANSYNC_PROJECT: cfg.project,
      LOG_LEVEL: 'warn',
      // CLI subscribes to SSE directly; ask MCP server to skip its listener so
      // the user doesn't see each event twice.
      PLANSYNC_MCP_DISABLE_SSE: '1',
    };

    this.serverPath = serverPath;
    this.intentionalShutdown = false;
    // Reset diagnostic buffers so a previous crash's output does not
    // contaminate the next spawn's surface area.
    this.childOutputLines = [];
    this.stderrAccumulator = '';
    this.proc = spawn(cfg.nodeBin, [serverPath], {
      // stderr is `pipe` (not `inherit`) so we can capture Node fatal-error
      // traces and surface them in the crash message instead of having them
      // race against the prompt.
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    const proc = this.proc;

    proc.stdout!.on('data', (chunk: Buffer) => {
      this.readBuffer += chunk.toString();
      const lines = this.readBuffer.split('\n');
      this.readBuffer = lines.pop() || '';
      // Closes #807: bound the partial-line buffer so a malicious or
      // misbehaving MCP child that writes a multi-megabyte line
      // without a trailing newline cannot grow `readBuffer` without
      // limit and OOM the CLI.
      //
      // Closes #871 / #913: the previous cap was the per-line
      // diagnostic cap (4 KiB), which is fine for log lines but FAR
      // too small for legitimate MCP JSON-RPC frames — a populated
      // `task_pack` response can be hundreds of kilobytes, and
      // anything that arrived in 2+ chunks would push the partial
      // buffer past 4 KiB before its trailing newline showed up,
      // and the buffer was dropped — request timed out, tool result
      // lost. The new cap (16 MiB) is generous enough to pass any
      // realistic single frame and still bounds memory at ~16 MB
      // per stdio reader.
      if (this.readBuffer.length > CHILD_STDOUT_PARTIAL_BUFFER_CAP) {
        this.recordChildOutput(this.readBuffer);
        this.readBuffer = '';
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Non-JSON on stdout (e.g. accidental console.log in a tool
          // handler). Capture for crash diagnostics; ignore otherwise.
          this.recordChildOutput(line);
          continue;
        }
        if (this.isJsonRpcFrame(parsed)) {
          this.handleMessage(parsed as Parameters<McpClient['handleMessage']>[0]);
        } else {
          // JSON that isn't a JSON-RPC frame is almost always pino —
          // the MCP server's logger defaults to stdout, so startup
          // errors like the R-040 "PLANSYNC_API_KEY is not set" land
          // here. Capture them for crash diagnostics so the user sees
          // a real repro instead of just "code 1".
          this.recordChildOutput(line);
        }
      }
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      this.stderrAccumulator += chunk.toString();
      const lines = this.stderrAccumulator.split('\n');
      this.stderrAccumulator = lines.pop() || '';
      // Closes #807: same bounded-growth guard as stdout above.
      // Without this a child that streams unbounded bytes to stderr
      // without a newline can OOM the CLI.
      if (this.stderrAccumulator.length > CHILD_OUTPUT_LINE_CAP) {
        this.recordChildOutput(this.stderrAccumulator);
        this.stderrAccumulator = '';
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        this.recordChildOutput(line);
      }
    });

    proc.on('error', (err) => {
      process.stdout.write(`\n${c.red}⚠ MCP server error: ${err.message}${c.reset}\n`);
    });

    // R-021: detect unexpected exits. Without this handler every pending
    // tool call hangs until the 30 s timeout fires and `this.proc` is never
    // cleared, so `isRunning()` keeps lying about state. We:
    //   1. mark the transport dead (`this.proc = null`)
    //   2. reject all pending requests with code `MCP_CRASHED` so callers
    //      can distinguish a crash from a generic timeout
    //   3. bump the crash counter for `isHealthy()` reporting
    //   4. surface a warning to the user
    // The handler intentionally ignores exits triggered by `stop()` so that
    // graceful shutdown does not look like a crash.
    //
    // Closes #792: we listen on `'close'` (not `'exit'`) for crash
    // summary generation. `'exit'` fires as soon as the child exits but
    // BEFORE its stdout/stderr have been drained — a fatal error
    // written immediately before exit may not yet be in our buffers,
    // which is the diagnostic line the user most needs. `'close'`
    // fires only after the streams emit `'end'`, so by the time we
    // build the summary every byte the child wrote is captured.
    proc.on('close', (code, signal) => this.handleExit(proc, code, signal));

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { logging: {} },
      clientInfo: { name: 'plansync-terminal', version: '0.1.0' },
    });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

    const result = await this.request('tools/list', {});
    this.tools = (result as { tools?: unknown[] }).tools || [];

    // R-021: reaching this point means the subprocess accepted JSON-RPC and
    // returned tool metadata. The previous crash streak (if any) is healed.
    this.consecutiveCrashes = 0;
  }

  private handleExit(proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    // Ignore stale exit events from a previous process instance.
    if (this.proc !== proc) return;
    this.proc = null;
    // Closes #808: previously this dropped the stdout partial-line
    // buffer (`this.readBuffer = ''`) without recording it. When the
    // MCP child crashes mid-pino-line on stdout (a fatal-error trace
    // can flush part of a JSON line and then die), the most diagnostic
    // bytes — the actual error message — used to be silently
    // discarded. Flush both buffers symmetrically.
    if (this.readBuffer.trim()) {
      this.recordChildOutput(this.readBuffer);
    }
    this.readBuffer = '';
    if (this.stderrAccumulator.trim()) {
      this.recordChildOutput(this.stderrAccumulator);
    }
    this.stderrAccumulator = '';

    const wasIntentional = this.intentionalShutdown;
    this.intentionalShutdown = false;

    const reason = signal ? `signal ${signal}` : code !== null ? `code ${code}` : 'unknown';

    const err = new Error(`MCP_CRASHED: subprocess exited (${reason})`);
    for (const { reject } of this.pending.values()) {
      try {
        reject(err);
      } catch {
        /* ignore listener errors */
      }
    }
    this.pending.clear();

    if (wasIntentional) return;

    this.consecutiveCrashes += 1;
    const summary = this.formatChildOutputForDisplay();
    // Guard the stdout writes — in tests / piped runs stdout can be closed
    // (EPIPE) by the time the child's exit event fires, and a synchronous
    // throw from this listener surfaces as an unhandled error in vitest.
    try {
      process.stdout.write(
        `\n${c.yellow}⚠ MCP subprocess exited unexpectedly (${reason}); the next tool call will attempt to restart it.${c.reset}\n`,
      );
      if (summary) {
        process.stdout.write(
          `${c.dim}  Last output from MCP child (most recent last):${c.reset}\n${summary}\n`,
        );
      }
    } catch (writeErr) {
      const errno = (writeErr as NodeJS.ErrnoException | undefined)?.code;
      if (errno !== 'EPIPE' && errno !== 'ERR_STREAM_DESTROYED') throw writeErr;
    }
  }

  /**
   * Append a captured line from the MCP child's stdout/stderr to the
   * diagnostic ring buffer, with caps to keep memory bounded even if the
   * child goes into a tight log loop.
   */
  private recordChildOutput(line: string): void {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed) return;
    const capped =
      trimmed.length > CHILD_OUTPUT_LINE_CAP
        ? trimmed.slice(0, CHILD_OUTPUT_LINE_CAP) + '…'
        : trimmed;
    this.childOutputLines.push(capped);
    if (this.childOutputLines.length > CHILD_OUTPUT_RING_LINES) {
      this.childOutputLines.splice(0, this.childOutputLines.length - CHILD_OUTPUT_RING_LINES);
    }
  }

  /** Heuristic: a JSON-RPC response or notification has either an `id` field or `method`+`jsonrpc`. */
  private isJsonRpcFrame(parsed: unknown): boolean {
    if (typeof parsed !== 'object' || parsed === null) return false;
    const o = parsed as { id?: unknown; method?: unknown; jsonrpc?: unknown };
    if (typeof o.id === 'number' || typeof o.id === 'string') return true;
    if (typeof o.method === 'string' && typeof o.jsonrpc === 'string') return true;
    return false;
  }

  /**
   * Render the ring buffer for human display. Each line gets indented and
   * colourised; if a line parses as pino-style JSON we extract the
   * `msg`/`err.message` fields so the user sees the operational message
   * instead of the full structured payload.
   */
  private formatChildOutputForDisplay(): string {
    if (this.childOutputLines.length === 0) return '';
    return this.childOutputLines
      .map((line) => `${c.dim}  │${c.reset} ${this.summariseLine(line)}`)
      .join('\n');
  }

  private summariseLine(line: string): string {
    const trimmed = line.trim();
    if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) return line;
    try {
      const obj = JSON.parse(trimmed) as {
        msg?: unknown;
        err?: { message?: unknown; type?: unknown };
        level?: unknown;
      };
      const msg = typeof obj.msg === 'string' ? obj.msg : '';
      const errMsg =
        obj.err && typeof obj.err.message === 'string'
          ? `${typeof obj.err.type === 'string' ? obj.err.type + ': ' : ''}${obj.err.message}`
          : '';
      if (msg || errMsg) {
        return [msg, errMsg].filter(Boolean).join(' — ');
      }
    } catch {
      /* fall through */
    }
    return line;
  }

  /**
   * Public read access to the diagnostic ring buffer so callers (status
   * banners, integration tests) can inspect what the child last said.
   * Returns a fresh copy so callers cannot mutate internal state.
   */
  getRecentChildOutput(): string[] {
    return [...this.childOutputLines];
  }

  private handleMessage(msg: {
    id?: number;
    error?: { message?: string };
    result?: unknown;
    method?: string;
    params?: { data?: unknown };
  }): void {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'notifications/message') {
      const data = msg.params?.data;
      const obj = (typeof data === 'object' && data !== null ? data : null) as Record<
        string,
        unknown
      > | null;

      // Drift v2 (S6): MCP server pushes { type: 'execution_aborted', ... }
      // when the API has aborted the run. Fire the registered handler so the
      // CLI's ai-loop AbortController flips. Still print the message so the
      // user sees what happened.
      if (obj?.type === 'execution_aborted' && this.abortHandler) {
        const reason: ExecutionAbortReason = {
          code: typeof obj.code === 'string' ? obj.code : 'RUN_ABORTED',
          message:
            typeof obj.message === 'string' ? obj.message : 'Execution aborted by PlanSync API',
          runId: typeof obj.runId === 'string' ? obj.runId : undefined,
          taskId: typeof obj.taskId === 'string' ? obj.taskId : undefined,
        };
        try {
          this.abortHandler(reason);
        } catch {
          /* abort handler errors are non-fatal */
        }
      }

      const text =
        typeof data === 'string'
          ? data
          : (data as { message?: string })?.message || JSON.stringify(data);
      if (text) {
        if (this.notifyPrinter) this.notifyPrinter(text);
        else process.stdout.write(`\n${c.yellow}[PlanSync] ${text}${c.reset}\n`);
      }
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.reqId;
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  private send(msg: object): void {
    this.proc?.stdin?.write(JSON.stringify(msg) + '\n');
  }

  getAnthropicTools(): { name: string; description: string; input_schema: unknown }[] {
    return (this.tools as { name: string; description?: string; inputSchema?: unknown }[]).map(
      (t) => ({
        name: t.name,
        description: t.description || '',
        input_schema: t.inputSchema || { type: 'object', properties: {} },
      }),
    );
  }

  async callTool(name: string, args: unknown): Promise<string> {
    // R-022: transport-level glitches (subprocess crashed between requests,
    // stdin closed, etc.) used to bubble straight to the LLM as a tool error.
    // We now make one transparent recovery attempt: if the subprocess is
    // already gone, restart it before sending; if the request fails with a
    // transport error, restart and retry exactly once. Real protocol errors
    // (validation, missing tool, server-side rejection) are NOT retried.
    if (!this.isRunning() && this.serverPath) {
      await this.ensureRunning(this.serverPath);
    }
    try {
      return await this.callToolOnce(name, args);
    } catch (err) {
      if (!this.isTransportError(err) || !this.serverPath) throw err;
      const ok = await this.ensureRunning(this.serverPath);
      if (!ok) throw err;
      return await this.callToolOnce(name, args);
    }
  }

  private async callToolOnce(name: string, args: unknown): Promise<string> {
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      content?: { type: string; text?: string }[];
    };
    const content = result.content || [];
    return content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
  }

  /**
   * R-022: distinguish "the JSON-RPC pipe died" from real protocol errors.
   * Only transport errors should trigger an automatic restart-and-retry —
   * retrying a malformed argument or a permission denied is never useful,
   * and retrying a `MCP timeout` could double-execute a tool that was simply
   * slow on the server side.
   */
  private isTransportError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return /MCP_CRASHED/.test(err.message) || /MCP shutdown/.test(err.message);
  }

  updateProject(projectId: string): void {
    this.stop();
    cfg.project = projectId;
  }

  stop(): void {
    if (this.proc) {
      // R-021: mark this as a graceful shutdown so the `exit` handler does
      // not increment the crash counter or surface a warning to the user.
      this.intentionalShutdown = true;
      try {
        this.proc.kill();
      } catch {
        /* swallow kill errors — the process may already be dead */
      }
    }
    // R-024: synchronously reject every pending request before nulling out
    // `proc`. The async `exit` event from kill() above would land in
    // handleExit() *after* `this.proc = null` flips its identity check, so
    // the pending map would otherwise live until each request's 30 s
    // timeout fires (the `stop 之后 pending Promise 永远不 resolve` bug).
    // Rejecting here closes that gap deterministically.
    if (this.pending.size > 0) {
      const err = new Error('MCP shutdown');
      for (const { reject } of this.pending.values()) {
        try {
          reject(err);
        } catch {
          /* swallow listener errors — pending must be cleared regardless */
        }
      }
      this.pending.clear();
    }
    this.proc = null;
  }

  isRunning(): boolean {
    return this.proc !== null;
  }

  /**
   * R-021: returns true while the consecutive-crash counter is below the
   * configured threshold. Once we cross it, callers should stop driving the
   * MCP loop and ask the user to investigate (see `index.ts` for how this
   * is surfaced).
   */
  isHealthy(): boolean {
    return this.consecutiveCrashes < MAX_CONSECUTIVE_CRASHES;
  }

  /** Test-only inspector for the crash counter. */
  _getConsecutiveCrashesForTests(): number {
    return this.consecutiveCrashes;
  }

  /**
   * Ensure MCP is running. If it crashed, restart it with exponential
   * backoff (up to 3 attempts). Returns true if healthy (or successfully
   * restarted), false if every restart attempt failed.
   */
  async ensureRunning(serverPath: string): Promise<boolean> {
    if (this.isRunning()) return true;

    let lastError: unknown = null;
    for (let attempt = 0; attempt < RESTART_BACKOFF_MS.length; attempt += 1) {
      if (RESTART_BACKOFF_MS[attempt] > 0) {
        await this.sleepFn(RESTART_BACKOFF_MS[attempt]);
      }
      try {
        await this.start(serverPath);
        return true;
      } catch (err) {
        lastError = err;
        // Make sure a half-spawned process is not left dangling between
        // attempts; otherwise `isRunning()` lies and the next attempt skips
        // the actual spawn.
        if (this.proc) {
          this.intentionalShutdown = true;
          try {
            this.proc.kill();
          } catch {
            /* ignore */
          }
          this.proc = null;
        }
      }
    }

    if (lastError) {
      const msg = lastError instanceof Error ? lastError.message : String(lastError);
      process.stdout.write(
        `\n${c.red}⚠ MCP restart failed after ${RESTART_BACKOFF_MS.length} attempts: ${msg}${c.reset}\n`,
      );
    }
    return false;
  }
}

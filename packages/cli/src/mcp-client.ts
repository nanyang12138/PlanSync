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

    this.intentionalShutdown = false;
    this.proc = spawn(cfg.nodeBin, [serverPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
    });

    const proc = this.proc;

    proc.stdout!.on('data', (chunk: Buffer) => {
      this.readBuffer += chunk.toString();
      const lines = this.readBuffer.split('\n');
      this.readBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.handleMessage(JSON.parse(line));
        } catch {
          /* ignore */
        }
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
    proc.on('exit', (code, signal) => this.handleExit(proc, code, signal));

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
    this.readBuffer = '';

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
    process.stdout.write(
      `\n${c.yellow}⚠ MCP subprocess exited unexpectedly (${reason}); the next tool call will attempt to restart it.${c.reset}\n`,
    );
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
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      content?: { type: string; text?: string }[];
    };
    const content = result.content || [];
    return content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
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

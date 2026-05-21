import { spawn, ChildProcess } from 'child_process';
import { cfg } from './config.js';
import { c } from './ui.js';

export interface ExecutionAbortReason {
  code: string;
  message: string;
  runId?: string;
  taskId?: string;
}

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

    this.proc = spawn(cfg.nodeBin, [serverPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => {
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

    this.proc.on('error', (err) => {
      process.stdout.write(`\n${c.red}⚠ MCP server error: ${err.message}${c.reset}\n`);
    });

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { logging: {} },
      clientInfo: { name: 'plansync-terminal', version: '0.1.0' },
    });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

    const result = await this.request('tools/list', {});
    this.tools = (result as { tools?: unknown[] }).tools || [];
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
    this.proc?.kill();
    this.proc = null;
  }

  isRunning(): boolean {
    return this.proc !== null;
  }

  /**
   * Ensure MCP is running. If it crashed, restart it.
   * Returns true if healthy (or successfully restarted), false if restart failed.
   */
  async ensureRunning(serverPath: string): Promise<boolean> {
    if (this.isRunning()) return true;
    try {
      await this.start(serverPath);
      return true;
    } catch {
      return false;
    }
  }
}

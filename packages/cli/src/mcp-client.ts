import { spawn, ChildProcess } from 'child_process';
import { cfg } from './config.js';
import { c } from './ui.js';

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

  setNotifyPrinter(fn: (text: string) => void): void {
    this.notifyPrinter = fn;
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

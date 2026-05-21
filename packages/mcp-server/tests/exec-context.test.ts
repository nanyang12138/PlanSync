// R-019: plansync_exec_context must distinguish fatal from transient errors.
// When PLANSYNC_EXEC_* env vars are set but task_pack fetch fails, the tool
// should stay in exec mode and tag the error as transient (network/5xx) or
// fatal (auth/4xx) instead of silently downgrading to execMode=false.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../src/api-client', async () => {
  // Preserve the real ApiError class so the production code can `instanceof` it.
  const actual = await vi.importActual<typeof import('../src/api-client')>('../src/api-client');
  return {
    ...actual,
    ApiClient: vi.fn().mockImplementation(() => ({
      get: mocks.get,
      post: mocks.post,
      patch: mocks.patch,
      delete: mocks.delete,
    })),
  };
});

import { ApiClient, ApiError } from '../src/api-client';
import { registerExecutionTools, heartbeatManager } from '../src/tools/execution';

const config = { apiBaseUrl: 'http://localhost:3001', apiToken: 't', userName: 'alice' };

function makeServer() {
  return new McpServer({ name: 'test', version: '0.0.1' });
}

function getToolHandler(
  server: McpServer,
  name: string,
): ((...args: unknown[]) => unknown) | undefined {
  const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })
    ._registeredTools;
  if (tools && tools[name]) {
    const t = tools[name] as { callback?: unknown; handler?: unknown };
    return (t.callback ?? t.handler) as ((...args: unknown[]) => unknown) | undefined;
  }
  return undefined;
}

async function callExecContext(server: McpServer): Promise<{
  execMode: boolean;
  runId?: string;
  taskId?: string;
  projectId?: string;
  error?: string;
  transient?: boolean;
  taskPack?: unknown;
}> {
  const handler = getToolHandler(server, 'plansync_exec_context');
  if (!handler) throw new Error('plansync_exec_context not registered');
  const out = (await handler({})) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(out.content[0].text);
}

describe('R-019: plansync_exec_context fatal vs transient classification', () => {
  let server: McpServer;
  let api: ApiClient;
  const savedEnv = {
    runId: process.env.PLANSYNC_EXEC_RUN_ID,
    taskId: process.env.PLANSYNC_EXEC_TASK_ID,
    projectId: process.env.PLANSYNC_PROJECT,
  };

  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
    mocks.patch.mockReset();
    mocks.delete.mockReset();
    server = makeServer();
    api = new ApiClient(config);
    registerExecutionTools(server, api);
  });

  afterEach(() => {
    // Restore env so cross-test state doesn't leak.
    if (savedEnv.runId === undefined) delete process.env.PLANSYNC_EXEC_RUN_ID;
    else process.env.PLANSYNC_EXEC_RUN_ID = savedEnv.runId;
    if (savedEnv.taskId === undefined) delete process.env.PLANSYNC_EXEC_TASK_ID;
    else process.env.PLANSYNC_EXEC_TASK_ID = savedEnv.taskId;
    if (savedEnv.projectId === undefined) delete process.env.PLANSYNC_PROJECT;
    else process.env.PLANSYNC_PROJECT = savedEnv.projectId;
    // Stop any heartbeat that the success path may have started.
    heartbeatManager.stopAll();
  });

  it('returns execMode:false (no transient flag) when env vars are unset', async () => {
    delete process.env.PLANSYNC_EXEC_RUN_ID;
    delete process.env.PLANSYNC_EXEC_TASK_ID;
    delete process.env.PLANSYNC_PROJECT;

    const result = await callExecContext(server);

    expect(result.execMode).toBe(false);
    expect(result.transient).toBeUndefined();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('flags ECONNRESET from task_pack as transient and stays in exec mode', async () => {
    process.env.PLANSYNC_EXEC_RUN_ID = 'run1';
    process.env.PLANSYNC_EXEC_TASK_ID = 'task1';
    process.env.PLANSYNC_PROJECT = 'proj1';

    const netErr = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    mocks.get.mockRejectedValueOnce(netErr);

    const result = await callExecContext(server);

    expect(result.execMode).toBe(true);
    expect(result.transient).toBe(true);
    expect(result.runId).toBe('run1');
    expect(result.taskId).toBe('task1');
    expect(result.projectId).toBe('proj1');
    expect(result.error).toContain('socket hang up');
    expect(result.taskPack).toBeUndefined();
  });

  it('flags fetch undici-style cause.code=ECONNREFUSED as transient', async () => {
    process.env.PLANSYNC_EXEC_RUN_ID = 'run1';
    process.env.PLANSYNC_EXEC_TASK_ID = 'task1';
    process.env.PLANSYNC_PROJECT = 'proj1';

    const fetchErr = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    mocks.get.mockRejectedValueOnce(fetchErr);

    const result = await callExecContext(server);

    expect(result.execMode).toBe(true);
    expect(result.transient).toBe(true);
  });

  it('flags ApiError 503 as transient', async () => {
    process.env.PLANSYNC_EXEC_RUN_ID = 'run1';
    process.env.PLANSYNC_EXEC_TASK_ID = 'task1';
    process.env.PLANSYNC_PROJECT = 'proj1';

    mocks.get.mockRejectedValueOnce(
      new ApiError('Service Unavailable', 'INTERNAL', 503),
    );

    const result = await callExecContext(server);

    expect(result.execMode).toBe(true);
    expect(result.transient).toBe(true);
    expect(result.error).toBe('Service Unavailable');
  });

  it('flags ApiError 404 as fatal (transient:false) but keeps execMode:true', async () => {
    process.env.PLANSYNC_EXEC_RUN_ID = 'run1';
    process.env.PLANSYNC_EXEC_TASK_ID = 'task1';
    process.env.PLANSYNC_PROJECT = 'proj1';

    mocks.get.mockRejectedValueOnce(new ApiError('Task not found', 'NOT_FOUND', 404));

    const result = await callExecContext(server);

    expect(result.execMode).toBe(true);
    expect(result.transient).toBe(false);
    expect(result.runId).toBe('run1');
    expect(result.error).toBe('Task not found');
  });

  it('flags ApiError 401 as fatal (transient:false)', async () => {
    process.env.PLANSYNC_EXEC_RUN_ID = 'run1';
    process.env.PLANSYNC_EXEC_TASK_ID = 'task1';
    process.env.PLANSYNC_PROJECT = 'proj1';

    mocks.get.mockRejectedValueOnce(new ApiError('Unauthorized', 'UNAUTHORIZED', 401));

    const result = await callExecContext(server);

    expect(result.execMode).toBe(true);
    expect(result.transient).toBe(false);
  });

  it('returns full task pack on success (regression: happy path unchanged)', async () => {
    process.env.PLANSYNC_EXEC_RUN_ID = 'run1';
    process.env.PLANSYNC_EXEC_TASK_ID = 'task1';
    process.env.PLANSYNC_PROJECT = 'proj1';

    mocks.get.mockResolvedValueOnce({ data: { task: { id: 'task1' }, plan: { version: 1 } } });

    const result = await callExecContext(server);

    expect(result.execMode).toBe(true);
    expect(result.runId).toBe('run1');
    expect(result.taskPack).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(result.transient).toBeUndefined();
  });
});

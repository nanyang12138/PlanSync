// R-020: plansync_exec_context must NOT auto-start the heartbeat when the
// task pack carries open drift alerts. Heartbeats keep the run alive on the
// API side, but the agent cannot make progress until drift is resolved
// (rebind / no_impact / cancel). The tool should instead return execMode:true
// with a `blocked: { reason: 'drift_unresolved', drifts, guidance }` envelope
// so the agent surfaces the drift list to the user and waits.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../src/api-client', async () => {
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

import { ApiClient } from '../src/api-client';
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

interface ExecContextResponse {
  execMode: boolean;
  runId?: string;
  taskId?: string;
  projectId?: string;
  taskPack?: unknown;
  blocked?: {
    reason: string;
    drifts: Array<{ id: string; severity: string; reason: string }>;
    guidance: string;
  };
  error?: string;
  transient?: boolean;
}

async function callExecContext(server: McpServer): Promise<ExecContextResponse> {
  const handler = getToolHandler(server, 'plansync_exec_context');
  if (!handler) throw new Error('plansync_exec_context not registered');
  const out = (await handler({})) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(out.content[0].text) as ExecContextResponse;
}

describe('R-020: plansync_exec_context blocks heartbeat on open drift', () => {
  let server: McpServer;
  let api: ApiClient;
  let startSpy: ReturnType<typeof vi.spyOn>;
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
    startSpy = vi.spyOn(heartbeatManager, 'start');
    registerExecutionTools(server, api);

    process.env.PLANSYNC_EXEC_RUN_ID = 'run1';
    process.env.PLANSYNC_EXEC_TASK_ID = 'task1';
    process.env.PLANSYNC_PROJECT = 'proj1';
  });

  afterEach(() => {
    if (savedEnv.runId === undefined) delete process.env.PLANSYNC_EXEC_RUN_ID;
    else process.env.PLANSYNC_EXEC_RUN_ID = savedEnv.runId;
    if (savedEnv.taskId === undefined) delete process.env.PLANSYNC_EXEC_TASK_ID;
    else process.env.PLANSYNC_EXEC_TASK_ID = savedEnv.taskId;
    if (savedEnv.projectId === undefined) delete process.env.PLANSYNC_PROJECT;
    else process.env.PLANSYNC_PROJECT = savedEnv.projectId;
    startSpy.mockRestore();
    heartbeatManager.stopAll();
  });

  it('does not start the heartbeat and returns blocked when driftAlerts is non-empty', async () => {
    const drifts = [
      { id: 'drift1', severity: 'high', reason: 'plan goal changed' },
      { id: 'drift2', severity: 'medium', reason: 'constraint added' },
    ];
    mocks.get.mockResolvedValueOnce({
      data: {
        task: { id: 'task1' },
        plan: { version: 2 },
        driftAlerts: drifts,
      },
    });

    const result = await callExecContext(server);

    expect(result.execMode).toBe(true);
    expect(result.runId).toBe('run1');
    expect(result.taskId).toBe('task1');
    expect(result.projectId).toBe('proj1');
    expect(result.taskPack).toBeDefined();
    expect(result.blocked).toBeDefined();
    expect(result.blocked?.reason).toBe('drift_unresolved');
    expect(result.blocked?.drifts).toEqual(drifts);
    expect(result.blocked?.guidance).toContain('Execution blocked');
    expect(result.blocked?.guidance).toContain('plansync_drift_resolve drift1 action=rebind');
    expect(result.blocked?.guidance).toContain('[HIGH]');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('starts heartbeat normally when driftAlerts is empty', async () => {
    mocks.get.mockResolvedValueOnce({
      data: {
        task: { id: 'task1' },
        plan: { version: 2 },
        driftAlerts: [],
      },
    });

    const result = await callExecContext(server);

    expect(result.execMode).toBe(true);
    expect(result.blocked).toBeUndefined();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith(
      'run1',
      'proj1',
      'task1',
      expect.anything(),
      expect.any(Function),
    );
  });

  it('starts heartbeat when driftAlerts field is missing', async () => {
    mocks.get.mockResolvedValueOnce({
      data: { task: { id: 'task1' }, plan: { version: 1 } },
    });

    const result = await callExecContext(server);

    expect(result.execMode).toBe(true);
    expect(result.blocked).toBeUndefined();
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});

// R-020: plansync_exec_context must NOT start the auto-heartbeat when the
// task has unresolved drift alerts. Instead it should return blocked=
// 'drift_unresolved' so the agent surfaces the drift to the owner and waits.
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

interface ExecContextResult {
  execMode: boolean;
  runId?: string;
  taskId?: string;
  projectId?: string;
  taskPack?: unknown;
  blocked?: string;
  driftAlerts?: Array<{ id: string; severity: string; reason: string }>;
  message?: string;
  error?: string;
  transient?: boolean;
}

async function callExecContext(server: McpServer): Promise<ExecContextResult> {
  const handler = getToolHandler(server, 'plansync_exec_context');
  if (!handler) throw new Error('plansync_exec_context not registered');
  const out = (await handler({})) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(out.content[0].text) as ExecContextResult;
}

function activeIntervalCount(): number {
  // The heartbeat manager keeps a private Map<runId, intervalId>. Peek at
  // its size so we can assert the heartbeat was (or was not) started without
  // waiting 30 seconds.
  const intervals = (heartbeatManager as unknown as { intervals: Map<string, unknown> }).intervals;
  return intervals.size;
}

describe('R-020: exec_context blocks heartbeat when task has open drifts', () => {
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
    heartbeatManager.stopAll();
    server = makeServer();
    api = new ApiClient(config);
    registerExecutionTools(server, api);

    process.env.PLANSYNC_EXEC_RUN_ID = 'run-r020';
    process.env.PLANSYNC_EXEC_TASK_ID = 'task-r020';
    process.env.PLANSYNC_PROJECT = 'proj-r020';
  });

  afterEach(() => {
    if (savedEnv.runId === undefined) delete process.env.PLANSYNC_EXEC_RUN_ID;
    else process.env.PLANSYNC_EXEC_RUN_ID = savedEnv.runId;
    if (savedEnv.taskId === undefined) delete process.env.PLANSYNC_EXEC_TASK_ID;
    else process.env.PLANSYNC_EXEC_TASK_ID = savedEnv.taskId;
    if (savedEnv.projectId === undefined) delete process.env.PLANSYNC_PROJECT;
    else process.env.PLANSYNC_PROJECT = savedEnv.projectId;
    heartbeatManager.stopAll();
  });

  it('returns blocked=drift_unresolved and does NOT start heartbeat when drifts are open', async () => {
    mocks.get.mockResolvedValueOnce({
      data: {
        task: { id: 'task-r020' },
        plan: { version: 2 },
        driftAlerts: [
          { id: 'd1', severity: 'high', reason: 'plan v1 → v2 changed deliverables' },
          { id: 'd2', severity: 'medium', reason: 'constraint added' },
        ],
      },
    });

    const result = await callExecContext(server);

    expect(result.execMode).toBe(true);
    expect(result.blocked).toBe('drift_unresolved');
    expect(result.taskPack).toEqual({
      task: { id: 'task-r020' },
      plan: { version: 2 },
      driftAlerts: [
        { id: 'd1', severity: 'high', reason: 'plan v1 → v2 changed deliverables' },
        { id: 'd2', severity: 'medium', reason: 'constraint added' },
      ],
    });
    expect(result.taskPack).not.toHaveProperty('data');
    expect(result.driftAlerts).toHaveLength(2);
    expect(result.driftAlerts?.[0]?.id).toBe('d1');
    expect(result.message).toContain('DRIFT DETECTED');
    expect(result.message).toContain('plansync_drift_resolve d1');
    expect(result.message).toContain('Heartbeat NOT started');
    // crucial: heartbeat must not be running for this run
    expect(activeIntervalCount()).toBe(0);
  });

  it('starts heartbeat normally when driftAlerts is empty', async () => {
    mocks.get.mockResolvedValueOnce({
      data: {
        task: { id: 'task-r020' },
        plan: { version: 1 },
        driftAlerts: [],
      },
    });

    const result = await callExecContext(server);

    expect(result.execMode).toBe(true);
    expect(result.blocked).toBeUndefined();
    expect(result.driftAlerts).toBeUndefined();
    expect(result.taskPack).toBeDefined();
    expect(activeIntervalCount()).toBe(1);
  });

  it('starts heartbeat when driftAlerts is missing on the task pack (legacy/empty payload)', async () => {
    mocks.get.mockResolvedValueOnce({
      data: { task: { id: 'task-r020' }, plan: { version: 1 } },
    });

    const result = await callExecContext(server);

    expect(result.execMode).toBe(true);
    expect(result.blocked).toBeUndefined();
    expect(activeIntervalCount()).toBe(1);
  });
});

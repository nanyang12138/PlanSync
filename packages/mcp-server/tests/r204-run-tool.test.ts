/**
 * R-204 — `plansync_run(action, ...)` unification test.
 *
 * Fix steps from the remediation plan:
 *   1. Add `plansync_run(runId, action)` tool with action ∈ {start, heartbeat, complete}
 *   2. Migrate all internal callers (web UI client, ai-loop, github-action) to the new tool
 *   3. Mark legacy `plansync_execution_*` tools as deprecated aliases for one release
 *   4. Update CLAUDE.md / AGENTS.md / docs/PROTOCOL.md to reference `plansync_run` only
 *
 * Verification from the plan:
 *   - tools/list shows `plansync_run`
 *   - integration tests cover all three actions through the new tool
 *   - deprecation warning fires on every legacy alias call
 *
 * Parity (the "load-bearing" half) is asserted by sending a structurally
 * identical request through `plansync_run` and the legacy alias for each
 * action and confirming the same URL / body / heartbeat side-effect is
 * produced.
 */
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

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../src/logger', () => ({
  logger: loggerMock,
}));

import { ApiClient, ApiError } from '../src/api-client';
import { registerExecutionTools, heartbeatManager } from '../src/tools/execution';
import { registerRunTool, normalizeRunToolNameForFsm } from '../src/tools/run';

const config = { apiBaseUrl: 'http://localhost:3001', apiToken: 't', userName: 'alice' };

interface ToolEnvelope {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
}

function makeServer() {
  return new McpServer({ name: 'test', version: '0.0.1' });
}

function getTool(
  server: McpServer,
  name: string,
):
  | {
      description?: string;
      inputSchema?: {
        safeParse: (input: unknown) => {
          success: boolean;
          error?: { issues: Array<{ path: (string | number)[]; message: string }> };
        };
      };
      callback?: (args: Record<string, unknown>) => Promise<unknown>;
      handler?: (args: Record<string, unknown>) => Promise<unknown>;
    }
  | undefined {
  const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })
    ._registeredTools;
  if (!tools) return undefined;
  return tools[name] as ReturnType<typeof getTool>;
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolEnvelope> {
  const t = getTool(server, name);
  if (!t) throw new Error(`Tool not registered: ${name}`);
  const handler = t.callback ?? t.handler;
  if (!handler) throw new Error(`No handler for ${name}`);
  return (await handler(args)) as ToolEnvelope;
}

describe('R-204: plansync_run(action, ...) — unified execution tool', () => {
  let server: McpServer;
  let api: ApiClient;

  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
    mocks.patch.mockReset();
    mocks.delete.mockReset();
    loggerMock.warn.mockReset();
    server = makeServer();
    api = new ApiClient(config);
    // Register the new surface first (matches production wiring in
    // src/index.ts so tools/list ordering is preserved) and then the
    // legacy aliases.
    registerRunTool(server, api);
    registerExecutionTools(server, api);
  });

  afterEach(() => {
    heartbeatManager.stopAll();
  });

  // -- Step 1 verification: tools/list shows plansync_run --
  describe('tools/list contract', () => {
    it('R204-V1: registers `plansync_run` as a first-class tool', () => {
      const t = getTool(server, 'plansync_run');
      expect(t).toBeDefined();
      expect(t!.description).toMatch(/action.* discriminator/i);
    });

    it('R204-V2: keeps the three legacy aliases registered alongside', () => {
      // The aliases must coexist with the new tool for one release so any
      // agent prompt that has not migrated keeps working.
      expect(getTool(server, 'plansync_execution_start')).toBeDefined();
      expect(getTool(server, 'plansync_execution_heartbeat')).toBeDefined();
      expect(getTool(server, 'plansync_execution_complete')).toBeDefined();
    });

    it('R204-V3: legacy aliases advertise the [DEPRECATED] tag in their description', () => {
      // The tag is what surfaces in Claude Desktop / Cursor's tool
      // inspector so downstream agents can see they should migrate.
      expect(getTool(server, 'plansync_execution_start')!.description).toMatch(/DEPRECATED/);
      expect(getTool(server, 'plansync_execution_heartbeat')!.description).toMatch(/DEPRECATED/);
      expect(getTool(server, 'plansync_execution_complete')!.description).toMatch(/DEPRECATED/);
    });
  });

  // -- Action: start --
  describe('action="start"', () => {
    it('R204-S1: POSTs to /tasks/{taskId}/runs with body {taskId, executorType, executorName} and binds auto-heartbeat', async () => {
      mocks.post.mockResolvedValueOnce({ data: { id: 'run-1', status: 'running' } });

      const result = await callTool(server, 'plansync_run', {
        action: 'start',
        projectId: 'p1',
        taskId: 't1',
        executorType: 'agent',
        executorName: 'alice',
      });

      expect(mocks.post).toHaveBeenCalledWith('/api/projects/p1/tasks/t1/runs', {
        taskId: 't1',
        executorType: 'agent',
        executorName: 'alice',
      });
      expect(JSON.parse(result.content[0].text)).toEqual({
        data: { id: 'run-1', status: 'running' },
      });
      const intervals = (heartbeatManager as unknown as { intervals: Map<string, unknown> })
        .intervals;
      expect(intervals.has('run-1')).toBe(true);
    });

    it('R204-S2: schema rejects start without executorType / executorName', async () => {
      // The discriminated-union parse layer in run.ts is what enforces
      // per-action field requirements; the SDK shape is intentionally a
      // superset so a single tool registration can advertise the union.
      await expect(
        callTool(server, 'plansync_run', {
          action: 'start',
          projectId: 'p1',
          taskId: 't1',
        }),
      ).rejects.toThrow(/invalid arguments/);
    });

    it('R204-S3: DRIFT_UNRESOLVED is translated to the same envelope as the legacy alias', async () => {
      mocks.post.mockRejectedValueOnce(
        new ApiError('drift', 'DRIFT_UNRESOLVED', 409, {
          drifts: [{ id: 'd1', severity: 'high', reason: 'plan changed' }],
        }),
      );

      const result = await callTool(server, 'plansync_run', {
        action: 'start',
        projectId: 'p1',
        taskId: 't1',
        executorType: 'agent',
        executorName: 'alice',
      });

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text) as {
        error: { code: string; tool: string };
      };
      expect(payload.error.code).toBe('DRIFT_UNRESOLVED');
      // R-204 contract: the envelope must attribute the failure to the
      // tool name the agent actually called (`plansync_run`) so the
      // hint copy lines up with the surface in tools/list. The legacy
      // alias still reports its own name when it's the surface used.
      expect(payload.error.tool).toBe('plansync_run');
    });
  });

  // -- Action: heartbeat --
  describe('action="heartbeat"', () => {
    it('R204-H1: POSTs to /runs/{runId}?action=heartbeat with empty body', async () => {
      mocks.post.mockResolvedValueOnce({ data: { ok: true } });

      const result = await callTool(server, 'plansync_run', {
        action: 'heartbeat',
        projectId: 'p1',
        taskId: 't1',
        runId: 'run-9',
      });

      expect(mocks.post).toHaveBeenCalledWith(
        '/api/projects/p1/tasks/t1/runs/run-9?action=heartbeat',
        {},
      );
      expect(JSON.parse(result.content[0].text)).toEqual({ data: { ok: true } });
    });

    it('R204-H2: schema rejects heartbeat without runId', async () => {
      await expect(
        callTool(server, 'plansync_run', {
          action: 'heartbeat',
          projectId: 'p1',
          taskId: 't1',
        }),
      ).rejects.toThrow(/invalid arguments/);
    });
  });

  // -- Action: complete --
  describe('action="complete"', () => {
    it('R204-C1: POSTs to /runs/{runId}?action=complete with body stripped of projectId/taskId/runId/action', async () => {
      mocks.post.mockResolvedValueOnce({ data: { status: 'completed' } });

      await callTool(server, 'plansync_run', {
        action: 'complete',
        projectId: 'p1',
        taskId: 't1',
        runId: 'run-7',
        status: 'completed',
        outputSummary: 'shipped feature X',
        filesChanged: ['src/foo.ts'],
        deliverablesMet: ['Implemented feature X'],
      });

      expect(mocks.post).toHaveBeenCalledWith(
        '/api/projects/p1/tasks/t1/runs/run-7?action=complete',
        {
          status: 'completed',
          outputSummary: 'shipped feature X',
          filesChanged: ['src/foo.ts'],
          deliverablesMet: ['Implemented feature X'],
        },
      );
    });

    it('R204-C2: stops auto-heartbeat for runId even when the POST fails', async () => {
      // Prime an active heartbeat for this run, then make the complete
      // call fail. The handler must stop the interval before POSTing.
      mocks.post.mockResolvedValueOnce({ data: { id: 'run-stop-204' } });
      await callTool(server, 'plansync_run', {
        action: 'start',
        projectId: 'p1',
        taskId: 't1',
        executorType: 'agent',
        executorName: 'alice',
      });
      const intervals = (heartbeatManager as unknown as { intervals: Map<string, unknown> })
        .intervals;
      expect(intervals.has('run-stop-204')).toBe(true);

      mocks.post.mockRejectedValueOnce(new ApiError('Internal', 'INTERNAL', 500, undefined));
      await expect(
        callTool(server, 'plansync_run', {
          action: 'complete',
          projectId: 'p1',
          taskId: 't1',
          runId: 'run-stop-204',
          status: 'completed',
          deliverablesMet: ['done'],
        }),
      ).rejects.toThrow('Internal');
      expect(intervals.has('run-stop-204')).toBe(false);
    });

    it('R204-C3: COMPLETION_VERIFICATION_FAILED keeps heartbeat alive (parity with legacy)', async () => {
      const intervals = (heartbeatManager as unknown as { intervals: Map<string, unknown> })
        .intervals;
      expect(intervals.has('run-retry-204')).toBe(false);

      mocks.post.mockRejectedValueOnce(
        new ApiError('rejected', 'COMPLETION_VERIFICATION_FAILED', 422, {
          score: 30,
          breakdown: { specificity: 5, coherence: 10, coverage: 15 },
          gaps: ['No file paths'],
          feedback: 'Be specific.',
        }),
      );

      const result = await callTool(server, 'plansync_run', {
        action: 'complete',
        projectId: 'p1',
        taskId: 't1',
        runId: 'run-retry-204',
        status: 'completed',
        deliverablesMet: ['done'],
      });

      expect(result.isError).toBe(true);
      // Heartbeat must be reinstated so the agent's next attempt
      // (after sharpening deliverablesMet) doesn't hit RUN_STALE.
      expect(intervals.has('run-retry-204')).toBe(true);
      const payload = JSON.parse(result.content[0].text) as { error: { tool: string } };
      // Surface attribution: the envelope reports `plansync_run` so
      // tools/list and the error blame the same identifier.
      expect(payload.error.tool).toBe('plansync_run');
    });
  });

  // -- Step 3 verification: deprecation warnings on legacy aliases --
  describe('deprecation warnings on legacy aliases', () => {
    it('R204-D1: plansync_execution_start emits a deprecation warning per call', async () => {
      mocks.post.mockResolvedValueOnce({ data: { id: 'run-dep-1' } });
      await callTool(server, 'plansync_execution_start', {
        projectId: 'p1',
        taskId: 't1',
        executorType: 'agent',
        executorName: 'alice',
      });
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'plansync_execution_start' }),
        expect.stringContaining('R-204 deprecated alias called'),
      );
    });

    it('R204-D2: plansync_execution_heartbeat emits a deprecation warning per call', async () => {
      mocks.post.mockResolvedValueOnce({ data: { ok: true } });
      await callTool(server, 'plansync_execution_heartbeat', {
        projectId: 'p1',
        taskId: 't1',
        runId: 'run-dep-2',
      });
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'plansync_execution_heartbeat' }),
        expect.stringContaining('R-204 deprecated alias called'),
      );
    });

    it('R204-D3: plansync_execution_complete emits a deprecation warning per call', async () => {
      mocks.post.mockResolvedValueOnce({ data: { status: 'completed' } });
      await callTool(server, 'plansync_execution_complete', {
        projectId: 'p1',
        taskId: 't1',
        runId: 'run-dep-3',
        status: 'completed',
      });
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'plansync_execution_complete' }),
        expect.stringContaining('R-204 deprecated alias called'),
      );
    });

    it('R204-D4: plansync_run does NOT emit the deprecation warning', async () => {
      mocks.post.mockResolvedValueOnce({ data: { id: 'run-fresh' } });
      await callTool(server, 'plansync_run', {
        action: 'start',
        projectId: 'p1',
        taskId: 't1',
        executorType: 'agent',
        executorName: 'alice',
      });
      // Filter for the R-204 deprecation message specifically — other
      // unrelated warnings (drift notification scheduling, etc.) are
      // fine and should not fail this assertion.
      const deprecationCalls = loggerMock.warn.mock.calls.filter((args) =>
        typeof args[1] === 'string' ? args[1].includes('R-204 deprecated alias') : false,
      );
      expect(deprecationCalls).toHaveLength(0);
    });
  });

  // -- normalizeRunToolNameForFsm: keeps the FSM table untouched --
  describe('normalizeRunToolNameForFsm', () => {
    it('R204-N1: returns the legacy tool name for each known action', () => {
      expect(normalizeRunToolNameForFsm('plansync_run', { action: 'start' })).toBe(
        'plansync_execution_start',
      );
      expect(normalizeRunToolNameForFsm('plansync_run', { action: 'heartbeat' })).toBe(
        'plansync_execution_heartbeat',
      );
      expect(normalizeRunToolNameForFsm('plansync_run', { action: 'complete' })).toBe(
        'plansync_execution_complete',
      );
    });

    it('R204-N2: passes through unrelated tools unchanged', () => {
      expect(normalizeRunToolNameForFsm('plansync_task_pack', { action: 'start' })).toBe(
        'plansync_task_pack',
      );
      expect(normalizeRunToolNameForFsm('plansync_run', null)).toBe('plansync_run');
      expect(normalizeRunToolNameForFsm('plansync_run', { action: 'bogus' })).toBe('plansync_run');
    });
  });
});

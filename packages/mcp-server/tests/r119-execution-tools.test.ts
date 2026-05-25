// R-119: Unit tests for plansync_execution_start / heartbeat / complete.
//
// Pre-R-119 coverage of these three MCP tools was scattered:
//   - r039-execution-error-envelope.test.ts covers the DRIFT_UNRESOLVED and
//     COMPLETION_VERIFICATION_FAILED branches (error envelopes only).
//   - r020-exec-context-drift-blocks-heartbeat.test.ts covers exec_context
//     gating heartbeat startup.
//   - heartbeat-abort.test.ts covers HeartbeatManager's drift-v2 abort
//     detection (RUN_PAUSED / RUN_STALE_VERSION / RUN_RACE_LOST).
//
// What was NOT covered:
//   - The happy-path contract of each execution_* tool: URL routing, body
//     shape, schema validation, and the auto-heartbeat lifecycle
//     (start binds on success, complete stops the run, completion errors
//     keep the heartbeat alive so the agent can retry).
//
// This file is the R-119 backstop for those gaps: every test pins down the
// exact public-facing behaviour of the three execution tools that the CLI
// and Genie depend on, so future refactors of `tools/execution.ts` cannot
// silently regress them.
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

import { ApiClient, ApiError } from '../src/api-client';
import {
  registerExecutionTools,
  heartbeatManager,
  isTransientExecContextError,
} from '../src/tools/execution';

const config = { apiBaseUrl: 'http://localhost:3001', apiToken: 't', userName: 'alice' };

function makeServer() {
  return new McpServer({ name: 'test', version: '0.0.1' });
}

function getToolHandler(
  server: McpServer,
  name: string,
): ((args: Record<string, unknown>) => Promise<unknown>) | undefined {
  // @ts-expect-error - internal SDK structure not in type definitions
  const tools = (server as any)._registeredTools ?? {};
  if (tools[name]) {
    return tools[name].callback ?? tools[name].handler ?? tools[name];
  }
  return undefined;
}

function getToolInputSchema(
  server: McpServer,
  name: string,
):
  | {
      safeParse: (input: unknown) => {
        success: boolean;
        error?: { issues: Array<{ path: (string | number)[]; message: string }> };
      };
    }
  | undefined {
  // @ts-expect-error - internal SDK structure not in type definitions
  const tools = (server as any)._registeredTools ?? {};
  return tools[name]?.inputSchema;
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const handler = getToolHandler(server, name);
  if (!handler) throw new Error(`Tool not found: ${name}`);
  return (await handler(args)) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
}

describe('R-119: MCP execution_* (start / heartbeat / complete) unit tests', () => {
  let server: McpServer;
  let api: ApiClient;

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
    // Defensive: any test that starts a heartbeat must not leak the interval
    // into a sibling test. stopAll() is idempotent.
    heartbeatManager.stopAll();
  });

  describe('plansync_execution_start', () => {
    it('R119-S1: POSTs to /tasks/{taskId}/runs with body {taskId, executorType, executorName}', async () => {
      mocks.post.mockResolvedValueOnce({ data: { id: 'run-1', status: 'running' } });

      const result = await callTool(server, 'plansync_execution_start', {
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
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual({
        data: { id: 'run-1', status: 'running' },
      });
      // Auto-heartbeat must be registered on success so the agent's run
      // stays alive without an explicit heartbeat call.
      heartbeatManager.stop('run-1');
    });

    it('R119-S2: registers auto-heartbeat when the API returns data.id', async () => {
      mocks.post.mockResolvedValueOnce({ data: { id: 'run-42', status: 'running' } });

      // Take a snapshot of intervals before, then assert the new runId
      // is tracked after. We use stop() as the public probe: if start()
      // never registered the run, the next stop() is a no-op and the
      // intervals map stays empty; if it did register, stop() removes it.
      const before = (heartbeatManager as unknown as { intervals: Map<string, unknown> }).intervals
        .size;

      await callTool(server, 'plansync_execution_start', {
        projectId: 'p1',
        taskId: 't1',
        executorType: 'agent',
        executorName: 'alice',
      });

      const intervals = (heartbeatManager as unknown as { intervals: Map<string, unknown> })
        .intervals;
      expect(intervals.size).toBe(before + 1);
      expect(intervals.has('run-42')).toBe(true);
    });

    it('R119-S3: schema rejects executorType outside ["human","agent"]', () => {
      const schema = getToolInputSchema(server, 'plansync_execution_start');
      expect(schema).toBeDefined();
      const result = schema!.safeParse({
        projectId: 'p1',
        taskId: 't1',
        executorType: 'robot',
        executorName: 'alice',
      });
      expect(result.success).toBe(false);
      const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'));
      expect(paths).toContain('executorType');
    });

    it('R119-S4: schema rejects missing required fields (projectId/taskId/executorName)', () => {
      const schema = getToolInputSchema(server, 'plansync_execution_start');
      expect(schema).toBeDefined();
      const result = schema!.safeParse({ executorType: 'agent' });
      expect(result.success).toBe(false);
      const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'));
      // The schema should flag every missing required field; we assert
      // each one individually so a future refactor that drops one is
      // caught here rather than at runtime.
      expect(paths).toContain('projectId');
      expect(paths).toContain('taskId');
      expect(paths).toContain('executorName');
    });

    it('R119-S5: does NOT register heartbeat when API response has no data.id (e.g. empty/malformed body)', async () => {
      mocks.post.mockResolvedValueOnce({ data: {} });
      const before = (heartbeatManager as unknown as { intervals: Map<string, unknown> }).intervals
        .size;

      await callTool(server, 'plansync_execution_start', {
        projectId: 'p1',
        taskId: 't1',
        executorType: 'agent',
        executorName: 'alice',
      });

      const after = (heartbeatManager as unknown as { intervals: Map<string, unknown> }).intervals
        .size;
      expect(after).toBe(before);
    });

    it('R119-S6: 403 FORBIDDEN (executor mismatch) is rethrown (not swallowed into an envelope)', async () => {
      // R-009 surfaces executor-identity mismatch as 403 FORBIDDEN. The
      // execution_start handler only catches DRIFT_UNRESOLVED — every
      // other ApiError must bubble up to the tool-wrapper layer so it
      // can be translated into a canonical R-037 envelope there.
      mocks.post.mockRejectedValueOnce(
        new ApiError('executorName mismatch', 'FORBIDDEN', 403, undefined),
      );

      await expect(
        callTool(server, 'plansync_execution_start', {
          projectId: 'p1',
          taskId: 't1',
          executorType: 'agent',
          executorName: 'alice',
        }),
      ).rejects.toThrow('executorName mismatch');
    });
  });

  describe('plansync_execution_heartbeat', () => {
    it('R119-H1: POSTs to /runs/{runId}?action=heartbeat with empty body', async () => {
      mocks.post.mockResolvedValueOnce({ data: { ok: true } });

      const result = await callTool(server, 'plansync_execution_heartbeat', {
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

    it('R119-H2: schema rejects missing projectId / taskId / runId', () => {
      const schema = getToolInputSchema(server, 'plansync_execution_heartbeat');
      expect(schema).toBeDefined();
      const result = schema!.safeParse({});
      expect(result.success).toBe(false);
      const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'));
      expect(paths).toContain('projectId');
      expect(paths).toContain('taskId');
      expect(paths).toContain('runId');
    });
  });

  describe('plansync_execution_complete', () => {
    it('R119-C1: POSTs to /runs/{runId}?action=complete with body stripped of projectId/taskId/runId', async () => {
      mocks.post.mockResolvedValueOnce({ data: { status: 'completed' } });

      await callTool(server, 'plansync_execution_complete', {
        projectId: 'p1',
        taskId: 't1',
        runId: 'run-7',
        status: 'completed',
        outputSummary: 'shipped feature X',
        filesChanged: ['src/foo.ts'],
        deliverablesMet: ['Implemented feature X with integration test'],
      });

      expect(mocks.post).toHaveBeenCalledWith(
        '/api/projects/p1/tasks/t1/runs/run-7?action=complete',
        // projectId / taskId / runId must NOT appear in the body — they
        // belong in the URL only. Sending them in the body confuses the
        // route handler's zod parser (R-038 / R-042).
        {
          status: 'completed',
          outputSummary: 'shipped feature X',
          filesChanged: ['src/foo.ts'],
          deliverablesMet: ['Implemented feature X with integration test'],
        },
      );
    });

    it('R119-C2: stops the heartbeat for runId before POSTing — even when the POST then fails', async () => {
      // Manually start a heartbeat for run-stop-1 so we can observe stop().
      mocks.post.mockResolvedValueOnce({ data: { id: 'run-stop-1' } });
      await callTool(server, 'plansync_execution_start', {
        projectId: 'p1',
        taskId: 't1',
        executorType: 'agent',
        executorName: 'alice',
      });
      const intervals = (heartbeatManager as unknown as { intervals: Map<string, unknown> })
        .intervals;
      expect(intervals.has('run-stop-1')).toBe(true);

      // Now make complete fail with a generic 500 — the handler must
      // still have stopped the heartbeat before the POST, otherwise a
      // stuck run would keep heart-beating against a dead row.
      mocks.post.mockRejectedValueOnce(new ApiError('Internal', 'INTERNAL', 500, undefined));

      await expect(
        callTool(server, 'plansync_execution_complete', {
          projectId: 'p1',
          taskId: 't1',
          runId: 'run-stop-1',
          status: 'completed',
          deliverablesMet: ['done'],
        }),
      ).rejects.toThrow('Internal');

      expect(intervals.has('run-stop-1')).toBe(false);
    });

    it('R119-C3: COMPLETION_VERIFICATION_FAILED keeps the heartbeat alive so the agent can retry', async () => {
      // Pre-condition: no heartbeat for this runId.
      const intervals = (heartbeatManager as unknown as { intervals: Map<string, unknown> })
        .intervals;
      expect(intervals.has('run-retry-1')).toBe(false);

      mocks.post.mockRejectedValueOnce(
        new ApiError('Completion rejected', 'COMPLETION_VERIFICATION_FAILED', 422, {
          score: 30,
          breakdown: { specificity: 5, coherence: 10, coverage: 15 },
          gaps: ['No file paths'],
          feedback: 'Be specific.',
        }),
      );

      const result = await callTool(server, 'plansync_execution_complete', {
        projectId: 'p1',
        taskId: 't1',
        runId: 'run-retry-1',
        status: 'completed',
        deliverablesMet: ['done'],
      });

      expect(result.isError).toBe(true);
      // Heartbeat MUST be back online so the agent's next attempt (after
      // sharpening deliverablesMet) does not hit RUN_STALE because of an
      // expired heartbeat between attempts.
      expect(intervals.has('run-retry-1')).toBe(true);
    });

    it('R119-C4: schema rejects status outside ["completed","failed"]', () => {
      const schema = getToolInputSchema(server, 'plansync_execution_complete');
      expect(schema).toBeDefined();
      const result = schema!.safeParse({
        projectId: 'p1',
        taskId: 't1',
        runId: 'run-1',
        status: 'cancelled',
      });
      expect(result.success).toBe(false);
      const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'));
      expect(paths).toContain('status');
    });

    it('R119-C5: schema accepts the full optional payload (deliverablesMet/filesChanged/branchName/etc.)', () => {
      const schema = getToolInputSchema(server, 'plansync_execution_complete');
      expect(schema).toBeDefined();
      const result = schema!.safeParse({
        projectId: 'p1',
        taskId: 't1',
        runId: 'run-1',
        status: 'completed',
        outputSummary: 'ok',
        filesChanged: ['a.ts', 'b.ts'],
        blockers: [],
        driftSignals: [],
        branchName: 'feature/x',
        deliverablesMet: ['Built X', 'Tested X'],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('isTransientExecContextError (R-019 helper used by exec_context)', () => {
    // The classifier is exported from tools/execution.ts and drives the
    // transient flag returned by plansync_exec_context. It's exercised
    // indirectly by r019, but those tests focus on the tool-level shape;
    // here we pin down the classification table directly so a regression
    // in the helper is localised quickly.

    it('R119-T1: 5xx ApiError is transient', () => {
      expect(isTransientExecContextError(new ApiError('boom', 'INTERNAL', 500, undefined))).toBe(
        true,
      );
      expect(isTransientExecContextError(new ApiError('gone', 'BAD_GATEWAY', 503, undefined))).toBe(
        true,
      );
    });

    it('R119-T2: 4xx ApiError is fatal (not transient)', () => {
      expect(
        isTransientExecContextError(new ApiError('nope', 'UNAUTHORIZED', 401, undefined)),
      ).toBe(false);
      expect(isTransientExecContextError(new ApiError('nope', 'FORBIDDEN', 403, undefined))).toBe(
        false,
      );
      expect(isTransientExecContextError(new ApiError('nope', 'NOT_FOUND', 404, undefined))).toBe(
        false,
      );
    });

    it('R119-T3: network errors via err.code are transient', () => {
      for (const code of [
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENETUNREACH',
        'EAI_AGAIN',
        'UND_ERR_SOCKET',
      ]) {
        const e: Error & { code?: string } = new Error('net');
        e.code = code;
        expect(isTransientExecContextError(e)).toBe(true);
      }
    });

    it('R119-T4: network errors via err.cause.code are transient (undici-wrapped)', () => {
      const e: Error & { cause?: { code?: string } } = new Error('fetch failed');
      e.cause = { code: 'ECONNREFUSED' };
      expect(isTransientExecContextError(e)).toBe(true);
    });

    it('R119-T5: unknown errors are fatal (not transient)', () => {
      expect(isTransientExecContextError(new Error('generic'))).toBe(false);
      expect(isTransientExecContextError('string error')).toBe(false);
      expect(isTransientExecContextError(undefined)).toBe(false);
      expect(isTransientExecContextError(null)).toBe(false);
    });
  });
});

// R-039: execution tools must return a uniform JSON error envelope on every
// failure branch. Before this change, `execution_start` returned a JSON
// envelope without `isError`, while `execution_complete` returned plain-text
// guidance for both DRIFT_UNRESOLVED and COMPLETION_VERIFICATION_FAILED, so
// MCP clients had no consistent way to detect failure or extract a code.
//
// All caught branches now share the canonical R-037 shape:
//   { isError: true, content: [{ type:'text', text: JSON.stringify({
//     error: { code, message, status, details, guidance, tool } }) }] }
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
import { registerExecutionTools, heartbeatManager } from '../src/tools/execution';

const config = { apiBaseUrl: 'http://localhost:3001', apiToken: 't', userName: 'alice' };

function makeServer() {
  return new McpServer({ name: 'test', version: '0.0.1' });
}

function getToolHandler(server: McpServer, name: string): ((args: unknown) => unknown) | undefined {
  const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })
    ._registeredTools;
  if (tools && tools[name]) {
    const t = tools[name] as { callback?: unknown; handler?: unknown };
    return (t.callback ?? t.handler) as ((args: unknown) => unknown) | undefined;
  }
  return undefined;
}

interface ToolEnvelope {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

interface ParsedError {
  code: string;
  message: string;
  status?: number;
  details?: unknown;
  guidance?: string;
  tool?: string;
}

function parseEnvelope(out: ToolEnvelope): { isError?: boolean; payload: { error: ParsedError } } {
  return { isError: out.isError, payload: JSON.parse(out.content[0].text) };
}

describe('R-039: execution tools uniform JSON error envelope', () => {
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
    heartbeatManager.stopAll();
  });

  it('execution_start DRIFT_UNRESOLVED returns isError:true envelope with code+drifts+guidance', async () => {
    const handler = getToolHandler(server, 'plansync_execution_start')!;
    const drifts = [
      { id: 'd1', severity: 'high', reason: 'plan goal changed' },
      { id: 'd2', severity: 'medium', reason: 'constraint added' },
    ];
    mocks.post.mockRejectedValueOnce(
      new ApiError('Drift unresolved', 'DRIFT_UNRESOLVED', 409, { drifts }),
    );

    const out = (await handler({
      projectId: 'p1',
      taskId: 't1',
      executorType: 'agent',
      executorName: 'alice',
    })) as ToolEnvelope;

    const { isError, payload } = parseEnvelope(out);
    expect(isError).toBe(true);
    expect(payload.error.code).toBe('DRIFT_UNRESOLVED');
    expect(payload.error.tool).toBe('plansync_execution_start');
    expect(payload.error.status).toBe(409);
    expect(payload.error.message).toBe('Drift unresolved');
    expect((payload.error.details as { drifts: typeof drifts }).drifts).toEqual(drifts);
    expect(payload.error.guidance).toContain('Execution blocked');
    expect(payload.error.guidance).toContain('plansync_drift_resolve d1');
    expect(payload.error.guidance).toContain('plansync_drift_resolve d2');
  });

  it('execution_complete DRIFT_UNRESOLVED returns isError:true envelope (was plain text before R-039)', async () => {
    const handler = getToolHandler(server, 'plansync_execution_complete')!;
    const drifts = [{ id: 'd9', severity: 'high', reason: 'plan changed mid-run' }];
    mocks.post.mockRejectedValueOnce(
      new ApiError('Drift unresolved', 'DRIFT_UNRESOLVED', 409, { drifts }),
    );

    const out = (await handler({
      projectId: 'p1',
      taskId: 't1',
      runId: 'r1',
      status: 'completed',
      deliverablesMet: ['Built X'],
    })) as ToolEnvelope;

    const { isError, payload } = parseEnvelope(out);
    expect(isError).toBe(true);
    expect(payload.error.code).toBe('DRIFT_UNRESOLVED');
    expect(payload.error.tool).toBe('plansync_execution_complete');
    expect((payload.error.details as { drifts: typeof drifts }).drifts).toEqual(drifts);
    expect(payload.error.guidance).toContain('plan changed while you were executing');
    expect(payload.error.guidance).toContain('plansync_drift_resolve d9');
  });

  it('execution_complete COMPLETION_VERIFICATION_FAILED returns isError:true envelope (was plain text before R-039)', async () => {
    const handler = getToolHandler(server, 'plansync_execution_complete')!;
    const verifyDetails = {
      score: 42,
      breakdown: { specificity: 10, coherence: 12, coverage: 20 },
      gaps: ['No file paths cited', 'No test names'],
      feedback: 'Add concrete deliverable evidence.',
    };
    mocks.post.mockRejectedValueOnce(
      new ApiError('Completion rejected', 'COMPLETION_VERIFICATION_FAILED', 422, verifyDetails),
    );

    const out = (await handler({
      projectId: 'p1',
      taskId: 't1',
      runId: 'r1',
      status: 'completed',
      deliverablesMet: ['done'],
    })) as ToolEnvelope;

    const { isError, payload } = parseEnvelope(out);
    expect(isError).toBe(true);
    expect(payload.error.code).toBe('COMPLETION_VERIFICATION_FAILED');
    expect(payload.error.tool).toBe('plansync_execution_complete');
    expect(payload.error.status).toBe(422);
    expect(payload.error.details).toEqual(verifyDetails);
    expect(payload.error.guidance).toContain('Score: 42/100');
    expect(payload.error.guidance).toContain('Specificity: 10/35');
    expect(payload.error.guidance).toContain('Coherence:   12/35');
    expect(payload.error.guidance).toContain('Coverage:    20/30');
    expect(payload.error.guidance).toContain('No file paths cited');
    expect(payload.error.guidance).toContain('Add concrete deliverable evidence.');
  });

  it('execution_complete COMPLETION_VERIFICATION_FAILED handles missing details gracefully', async () => {
    const handler = getToolHandler(server, 'plansync_execution_complete')!;
    mocks.post.mockRejectedValueOnce(
      new ApiError('Completion rejected', 'COMPLETION_VERIFICATION_FAILED', 422, undefined),
    );

    const out = (await handler({
      projectId: 'p1',
      taskId: 't1',
      runId: 'r1',
      status: 'completed',
      deliverablesMet: ['done'],
    })) as ToolEnvelope;

    const { isError, payload } = parseEnvelope(out);
    expect(isError).toBe(true);
    expect(payload.error.code).toBe('COMPLETION_VERIFICATION_FAILED');
    expect(payload.error.guidance).toContain('Score: ?/100');
    expect(payload.error.guidance).toContain('(none returned)');
    expect(payload.error.guidance).toContain('Feedback: Completion rejected');
  });

  it('execution_complete success path is unchanged (plain JSON, no isError)', async () => {
    const handler = getToolHandler(server, 'plansync_execution_complete')!;
    mocks.post.mockResolvedValueOnce({ data: { status: 'completed' } });

    const out = (await handler({
      projectId: 'p1',
      taskId: 't1',
      runId: 'r1',
      status: 'completed',
      deliverablesMet: ['Built X'],
    })) as ToolEnvelope;

    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content[0].text)).toEqual({ data: { status: 'completed' } });
  });

  it('execution_start non-DRIFT errors still propagate to the wrapper (rethrow)', async () => {
    const handler = getToolHandler(server, 'plansync_execution_start')!;
    mocks.post.mockRejectedValueOnce(new ApiError('Forbidden', 'FORBIDDEN', 403));

    await expect(
      handler({
        projectId: 'p1',
        taskId: 't1',
        executorType: 'agent',
        executorName: 'alice',
      }),
    ).rejects.toThrow('Forbidden');
  });
});

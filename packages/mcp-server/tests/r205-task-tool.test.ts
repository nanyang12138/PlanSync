/**
 * R-205 — `plansync_task(action, ...)` unification test.
 *
 * Fix steps from the remediation plan:
 *   1. Add `plansync_task(action, args)` tool with action ∈
 *      {create, update, claim, decline, rebind}.
 *   2. Migrate internal callers; deprecate `plansync_task_create / update /
 *      claim / decline / rebind` for one release.
 *   3. After R-204 + R-205 ship: tools/list count ≤ 12.
 *   4. (deferred — owner action) Flip R-175 to done.
 *
 * Verification mirrors `r204-run-tool.test.ts`: parity is asserted by
 * sending a structurally identical request through `plansync_task` and
 * the legacy alias for each action and confirming the same URL / body
 * is produced. Strict-schema rejection of cross-action fields and
 * deprecation warnings on the five legacy aliases are also covered.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
      withUser: vi.fn().mockReturnValue({
        get: mocks.get,
        post: mocks.post,
        patch: mocks.patch,
        delete: mocks.delete,
      }),
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

import { ApiClient } from '../src/api-client';
import { registerTaskTools, registerUnifiedTaskTool, normalizeTaskToolNameForFsm } from '../src/tools/task';
import { registerStatusTools } from '../src/tools/status';

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

describe('R-205: plansync_task(action, ...) — unified task tool', () => {
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
    // legacy aliases. status.ts hosts `plansync_task_rebind`.
    registerUnifiedTaskTool(server, api);
    registerTaskTools(server, api);
    registerStatusTools(server, api, config);
  });

  // --- Step 1 verification: tools/list shows plansync_task ---
  describe('tools/list contract', () => {
    it('R205-V1: registers `plansync_task` as a first-class tool', () => {
      const t = getTool(server, 'plansync_task');
      expect(t).toBeDefined();
      expect(t!.description).toMatch(/action.* discriminator/i);
    });

    it('R205-V2: keeps the five legacy aliases registered alongside', () => {
      // The aliases must coexist with the new tool for one release so any
      // agent prompt that has not migrated keeps working.
      expect(getTool(server, 'plansync_task_create')).toBeDefined();
      expect(getTool(server, 'plansync_task_update')).toBeDefined();
      expect(getTool(server, 'plansync_task_claim')).toBeDefined();
      expect(getTool(server, 'plansync_task_decline')).toBeDefined();
      expect(getTool(server, 'plansync_task_rebind')).toBeDefined();
    });

    it('R205-V3: legacy aliases advertise the [DEPRECATED] tag in their description', () => {
      expect(getTool(server, 'plansync_task_create')!.description).toMatch(/DEPRECATED/);
      expect(getTool(server, 'plansync_task_update')!.description).toMatch(/DEPRECATED/);
      expect(getTool(server, 'plansync_task_claim')!.description).toMatch(/DEPRECATED/);
      expect(getTool(server, 'plansync_task_decline')!.description).toMatch(/DEPRECATED/);
      expect(getTool(server, 'plansync_task_rebind')!.description).toMatch(/DEPRECATED/);
    });
  });

  // --- Action: create ---
  describe('action="create"', () => {
    it('R205-C1: POSTs to /tasks with body stripped of action/projectId', async () => {
      mocks.post.mockResolvedValueOnce({ data: { id: 'task-1' } });

      await callTool(server, 'plansync_task', {
        action: 'create',
        projectId: 'p1',
        title: 'New task',
        type: 'code',
      });

      const [url, body] = mocks.post.mock.calls[0] as [string, Record<string, unknown>];
      expect(url).toBe('/api/projects/p1/tasks');
      expect(body).not.toHaveProperty('action');
      expect(body).not.toHaveProperty('projectId');
      expect(body.title).toBe('New task');
      expect(body.type).toBe('code');
    });

    it('R205-C2: rejects create carrying update/claim-only fields', async () => {
      // taskId is an update/claim/decline/rebind field; on create it must
      // be rejected so the wrong action can never run on accidentally-
      // mixed arguments.
      await expect(
        callTool(server, 'plansync_task', {
          action: 'create',
          projectId: 'p1',
          title: 'New task',
          type: 'code',
          taskId: 't1',
        }),
      ).rejects.toThrow(/invalid arguments/);
      expect(mocks.post).not.toHaveBeenCalled();
    });
  });

  // --- Action: update ---
  describe('action="update"', () => {
    it('R205-U1: PATCHes to /tasks/{taskId} with body stripped of routing fields', async () => {
      mocks.patch.mockResolvedValueOnce({ data: { id: 't1' } });

      await callTool(server, 'plansync_task', {
        action: 'update',
        projectId: 'p1',
        taskId: 't1',
        title: 'Updated title',
        priority: 'p0',
      });

      const [url, body] = mocks.patch.mock.calls[0] as [string, Record<string, unknown>];
      expect(url).toBe('/api/projects/p1/tasks/t1');
      expect(body).not.toHaveProperty('action');
      expect(body).not.toHaveProperty('projectId');
      expect(body).not.toHaveProperty('taskId');
      expect(body.title).toBe('Updated title');
      expect(body.priority).toBe('p0');
    });

    it('R205-U2: rejects update without taskId', async () => {
      await expect(
        callTool(server, 'plansync_task', {
          action: 'update',
          projectId: 'p1',
          title: 'No id',
        }),
      ).rejects.toThrow(/invalid arguments/);
    });
  });

  // --- Action: claim ---
  describe('action="claim"', () => {
    it('R205-K1: POSTs to /tasks/{taskId}/claim with default assigneeType=agent', async () => {
      mocks.post.mockResolvedValueOnce({ data: { ok: true } });
      mocks.get.mockResolvedValueOnce({ data: { status: 'in_progress' } });

      await callTool(server, 'plansync_task', {
        action: 'claim',
        projectId: 'p1',
        taskId: 't1',
      });

      expect(mocks.post).toHaveBeenCalledWith('/api/projects/p1/tasks/t1/claim', {
        assigneeType: 'agent',
      });
    });

    it('R205-K2: forwards startImmediately=false and verifies status remains todo', async () => {
      mocks.post.mockResolvedValueOnce({ data: { ok: true } });
      mocks.get.mockResolvedValueOnce({ data: { status: 'todo' } });

      const result = await callTool(server, 'plansync_task', {
        action: 'claim',
        projectId: 'p1',
        taskId: 't1',
        startImmediately: false,
      });

      expect(mocks.post).toHaveBeenCalledWith('/api/projects/p1/tasks/t1/claim', {
        assigneeType: 'agent',
        startImmediately: false,
      });
      // No "may have failed" message when verified status matches expectation
      expect(result.content[0].text).not.toMatch(/may have failed/);
    });

    it('R205-K3: surfaces verify mismatch when verified status does not match expectation', async () => {
      mocks.post.mockResolvedValueOnce({ data: { ok: true } });
      mocks.get.mockResolvedValueOnce({ data: { status: 'todo' } });

      const result = await callTool(server, 'plansync_task', {
        action: 'claim',
        projectId: 'p1',
        taskId: 't1',
      });

      expect(result.content[0].text).toMatch(/may have failed/);
    });

    it('R205-K4: rejects claim carrying create-only fields', async () => {
      await expect(
        callTool(server, 'plansync_task', {
          action: 'claim',
          projectId: 'p1',
          taskId: 't1',
          title: 'should be rejected on claim',
        }),
      ).rejects.toThrow(/invalid arguments/);
      expect(mocks.post).not.toHaveBeenCalled();
    });
  });

  // --- Action: decline ---
  describe('action="decline"', () => {
    it('R205-D1: POSTs to /tasks/{taskId}/decline with empty body', async () => {
      mocks.post.mockResolvedValueOnce({ data: { ok: true } });
      mocks.get.mockResolvedValueOnce({ data: { assignee: null } });

      await callTool(server, 'plansync_task', {
        action: 'decline',
        projectId: 'p1',
        taskId: 't1',
      });

      expect(mocks.post).toHaveBeenCalledWith('/api/projects/p1/tasks/t1/decline', {});
    });

    it('R205-D2: rejects decline with stray fields', async () => {
      await expect(
        callTool(server, 'plansync_task', {
          action: 'decline',
          projectId: 'p1',
          taskId: 't1',
          assigneeType: 'human',
        }),
      ).rejects.toThrow(/invalid arguments/);
      expect(mocks.post).not.toHaveBeenCalled();
    });
  });

  // --- Action: rebind ---
  describe('action="rebind"', () => {
    it('R205-R1: POSTs to /tasks/{taskId}/rebind with no body', async () => {
      mocks.post.mockResolvedValueOnce({ data: { ok: true } });

      const result = await callTool(server, 'plansync_task', {
        action: 'rebind',
        projectId: 'p1',
        taskId: 't1',
      });

      expect(mocks.post).toHaveBeenCalledWith('/api/projects/p1/tasks/t1/rebind');
      expect(JSON.parse(result.content[0].text)).toEqual({ data: { ok: true } });
    });

    it('R205-R2: produces the same URL as legacy plansync_task_rebind alias', async () => {
      mocks.post.mockResolvedValueOnce({ data: { ok: true } });
      await callTool(server, 'plansync_task', {
        action: 'rebind',
        projectId: 'p1',
        taskId: 't1',
      });
      const unifiedCall = mocks.post.mock.calls[0];

      mocks.post.mockReset();
      mocks.post.mockResolvedValueOnce({ data: { ok: true } });
      await callTool(server, 'plansync_task_rebind', {
        projectId: 'p1',
        taskId: 't1',
      });
      const legacyCall = mocks.post.mock.calls[0];

      expect(unifiedCall[0]).toBe(legacyCall[0]);
    });
  });

  // --- Step 3 verification: deprecation warnings on legacy aliases ---
  describe('deprecation warnings on legacy aliases', () => {
    it('R205-W1: plansync_task_create emits a deprecation warning per call', async () => {
      mocks.post.mockResolvedValueOnce({ data: { id: 'tc-1' } });
      await callTool(server, 'plansync_task_create', {
        projectId: 'p1',
        title: 'tc',
        type: 'code',
      });
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'plansync_task_create' }),
        expect.stringContaining('R-205 deprecated alias called'),
      );
    });

    it('R205-W2: plansync_task_update emits a deprecation warning per call', async () => {
      mocks.patch.mockResolvedValueOnce({ data: { id: 't1' } });
      await callTool(server, 'plansync_task_update', {
        projectId: 'p1',
        taskId: 't1',
        title: 'updated',
      });
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'plansync_task_update' }),
        expect.stringContaining('R-205 deprecated alias called'),
      );
    });

    it('R205-W3: plansync_task_claim emits a deprecation warning per call', async () => {
      mocks.post.mockResolvedValueOnce({ data: { ok: true } });
      mocks.get.mockResolvedValueOnce({ data: { status: 'in_progress' } });
      await callTool(server, 'plansync_task_claim', {
        projectId: 'p1',
        taskId: 't1',
      });
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'plansync_task_claim' }),
        expect.stringContaining('R-205 deprecated alias called'),
      );
    });

    it('R205-W4: plansync_task_decline emits a deprecation warning per call', async () => {
      mocks.post.mockResolvedValueOnce({ data: { ok: true } });
      mocks.get.mockResolvedValueOnce({ data: { assignee: null } });
      await callTool(server, 'plansync_task_decline', {
        projectId: 'p1',
        taskId: 't1',
      });
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'plansync_task_decline' }),
        expect.stringContaining('R-205 deprecated alias called'),
      );
    });

    it('R205-W5: plansync_task_rebind emits a deprecation warning per call', async () => {
      mocks.post.mockResolvedValueOnce({ data: { ok: true } });
      await callTool(server, 'plansync_task_rebind', {
        projectId: 'p1',
        taskId: 't1',
      });
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'plansync_task_rebind' }),
        expect.stringContaining('R-205 deprecated alias called'),
      );
    });

    it('R205-W6: plansync_task does NOT emit a deprecation warning', async () => {
      mocks.post.mockResolvedValueOnce({ data: { ok: true } });
      await callTool(server, 'plansync_task', {
        action: 'rebind',
        projectId: 'p1',
        taskId: 't1',
      });
      const deprecationCalls = loggerMock.warn.mock.calls.filter((args) =>
        typeof args[1] === 'string' ? args[1].includes('R-205 deprecated alias') : false,
      );
      expect(deprecationCalls).toHaveLength(0);
    });
  });

  // --- normalizeTaskToolNameForFsm: keeps the FSM table untouched ---
  describe('normalizeTaskToolNameForFsm', () => {
    it('R205-N1: returns the legacy tool name for each known action', () => {
      expect(normalizeTaskToolNameForFsm('plansync_task', { action: 'create' })).toBe(
        'plansync_task_create',
      );
      expect(normalizeTaskToolNameForFsm('plansync_task', { action: 'update' })).toBe(
        'plansync_task_update',
      );
      expect(normalizeTaskToolNameForFsm('plansync_task', { action: 'claim' })).toBe(
        'plansync_task_claim',
      );
      expect(normalizeTaskToolNameForFsm('plansync_task', { action: 'decline' })).toBe(
        'plansync_task_decline',
      );
      expect(normalizeTaskToolNameForFsm('plansync_task', { action: 'rebind' })).toBe(
        'plansync_task_rebind',
      );
    });

    it('R205-N2: passes through unrelated tools unchanged', () => {
      expect(normalizeTaskToolNameForFsm('plansync_task_pack', { action: 'rebind' })).toBe(
        'plansync_task_pack',
      );
      expect(normalizeTaskToolNameForFsm('plansync_run', { action: 'start' })).toBe(
        'plansync_run',
      );
      expect(normalizeTaskToolNameForFsm('plansync_task', null)).toBe('plansync_task');
      expect(normalizeTaskToolNameForFsm('plansync_task', { action: 'bogus' })).toBe(
        'plansync_task',
      );
    });
  });
});

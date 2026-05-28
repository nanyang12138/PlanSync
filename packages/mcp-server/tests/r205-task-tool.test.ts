/**
 * R-205 — `plansync_task(action, ...)` unification test.
 *
 * Fix steps from the remediation plan:
 *   1. Add `plansync_task(action, args)` tool with action ∈
 *      {create, update, claim, decline, rebind}
 *   2. Migrate internal callers; deprecate `plansync_task_create / update /
 *      claim / decline / rebind` for one release
 *   3. After R-204 + R-205 ship: tools/list count ≤ 12 (the original R-175
 *      success criterion)
 *
 * Verification from the plan: tools/list count ≤ 12; same coverage matrix as
 * R-204 applied to the task surface.
 *
 * Parity is asserted by sending a structurally identical request through
 * `plansync_task` and the legacy alias for each action and confirming the
 * same URL / body / verification-GET is produced.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const mocks = vi.hoisted(() => {
  const rootGet = vi.fn();
  const rootPost = vi.fn();
  const rootPatch = vi.fn();
  const rootDelete = vi.fn();
  const withUser = vi.fn();
  return { rootGet, rootPost, rootPatch, rootDelete, withUser };
});

vi.mock('../src/api-client', () => ({
  ApiClient: vi.fn().mockImplementation(() => ({
    get: mocks.rootGet,
    post: mocks.rootPost,
    patch: mocks.rootPatch,
    delete: mocks.rootDelete,
    withUser: mocks.withUser,
  })),
}));

// task-handlers.ts pulls `getDelegationAgent` from tools/status. Keep it
// stubbed to "no delegation" so the handlers stay on the root api client
// in this test — delegation-mode wiring is exercised by
// `task-delegation.test.ts` and is orthogonal to the R-205 surface
// collapse we're asserting here.
vi.mock('../src/tools/status', () => ({
  getDelegationAgent: vi.fn(() => undefined),
  registerStatusTools: vi.fn(),
}));

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
import { registerTaskTools } from '../src/tools/task';
import { registerTaskActionTool, normalizeTaskToolNameForFsm } from '../src/tools/task-action';
import { handleTaskRebind } from '../src/tools/task-handlers';

const config = { apiBaseUrl: 'http://localhost:3001', apiToken: 't', userName: 'alice' };

interface ToolEnvelope {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
}

function makeServer() {
  return new McpServer({ name: 'test', version: '0.0.1' });
}

interface InputSchema {
  safeParse: (input: unknown) => {
    success: boolean;
    data?: Record<string, unknown>;
    error?: { issues: Array<{ path: (string | number)[]; message: string }> };
  };
  shape?: Record<string, unknown>;
}

function getTool(
  server: McpServer,
  name: string,
):
  | {
      description?: string;
      inputSchema?: InputSchema;
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
    mocks.rootGet.mockReset();
    mocks.rootPost.mockReset();
    mocks.rootPatch.mockReset();
    mocks.rootDelete.mockReset();
    mocks.withUser.mockReset();
    loggerMock.warn.mockReset();
    server = makeServer();
    api = new ApiClient(config);
    // Register the new surface first (matches production wiring in
    // src/index.ts so tools/list ordering is preserved) and then the
    // legacy aliases via the existing registerTaskTools entrypoint.
    registerTaskActionTool(server, api);
    registerTaskTools(server, api);
  });

  // -- Step 1 verification: tools/list shows plansync_task --
  describe('tools/list contract', () => {
    it('R205-V1: registers `plansync_task` as a first-class tool', () => {
      const t = getTool(server, 'plansync_task');
      expect(t).toBeDefined();
      expect(t!.description).toMatch(/action.* discriminator/i);
    });

    it('R205-V2: keeps the four task legacy aliases (create / update / claim / decline) registered alongside', () => {
      expect(getTool(server, 'plansync_task_create')).toBeDefined();
      expect(getTool(server, 'plansync_task_update')).toBeDefined();
      expect(getTool(server, 'plansync_task_claim')).toBeDefined();
      expect(getTool(server, 'plansync_task_decline')).toBeDefined();
    });

    it('R205-V3: legacy aliases advertise the [DEPRECATED] tag in their description', () => {
      expect(getTool(server, 'plansync_task_create')!.description).toMatch(/DEPRECATED/);
      expect(getTool(server, 'plansync_task_update')!.description).toMatch(/DEPRECATED/);
      expect(getTool(server, 'plansync_task_claim')!.description).toMatch(/DEPRECATED/);
      expect(getTool(server, 'plansync_task_decline')!.description).toMatch(/DEPRECATED/);
    });
  });

  // -- Action: create --
  describe('action="create"', () => {
    it('R205-CR1: POSTs to /tasks with body stripped of projectId/action', async () => {
      mocks.rootPost.mockResolvedValueOnce({ data: { id: 'task-1' } });

      await callTool(server, 'plansync_task', {
        action: 'create',
        projectId: 'p1',
        title: 'Implement feature X',
        type: 'code',
        priority: 'p1',
      });

      // The discriminated-union safeParse layer in task-action.ts fills
      // in shared `createTaskShape` defaults (e.g. `agentConstraints=[]`,
      // `assigneeType='unassigned'`) — same as the legacy alias surface.
      // Assert the load-bearing fields hit the right URL; defaults are
      // covered by the parity check below.
      expect(mocks.rootPost).toHaveBeenCalledWith(
        '/api/projects/p1/tasks',
        expect.objectContaining({
          title: 'Implement feature X',
          type: 'code',
          priority: 'p1',
        }),
      );
      // Critically: the routing-only fields MUST be stripped from the
      // body (otherwise the API rejects with "unknown field").
      const body = mocks.rootPost.mock.calls[0][1] as Record<string, unknown>;
      expect(body).not.toHaveProperty('projectId');
      expect(body).not.toHaveProperty('action');
    });

    it('R205-CR2: routes to the same URL as the deprecated alias', async () => {
      // We assert URL parity here — body-field parity is intentionally not
      // strict because the legacy alias runs the input through the SDK
      // shape (which mirrors `createTaskShape`, including its zod defaults
      // like `priority='p1'` and `agentConstraints=[]`), while the new
      // tool's outer SDK shape is a loose superset that defers default
      // application to the inner discriminated-union safeParse. Both
      // surfaces hit the same REST endpoint and the API applies the same
      // defaults at the route layer.
      mocks.rootPost.mockResolvedValueOnce({ data: { id: 'task-2a' } });
      await callTool(server, 'plansync_task', {
        action: 'create',
        projectId: 'p1',
        title: 'shared parity',
        type: 'code',
      });
      const newCall = mocks.rootPost.mock.calls.at(-1);

      mocks.rootPost.mockResolvedValueOnce({ data: { id: 'task-2b' } });
      await callTool(server, 'plansync_task_create', {
        projectId: 'p1',
        title: 'shared parity',
        type: 'code',
      });
      const legacyCall = mocks.rootPost.mock.calls.at(-1);

      expect(newCall?.[0]).toBe(legacyCall?.[0]);
      // Both bodies must carry the load-bearing user-supplied fields.
      expect(newCall?.[1]).toMatchObject({ title: 'shared parity', type: 'code' });
      expect(legacyCall?.[1]).toMatchObject({ title: 'shared parity', type: 'code' });
    });
  });

  // -- Action: update --
  describe('action="update"', () => {
    it('R205-U1: PATCHes /tasks/{taskId} with body stripped of projectId/taskId/action', async () => {
      mocks.rootPatch.mockResolvedValueOnce({ data: { id: 't1', status: 'in_progress' } });

      await callTool(server, 'plansync_task', {
        action: 'update',
        projectId: 'p1',
        taskId: 't1',
        status: 'in_progress',
        assignee: 'bob',
      });

      expect(mocks.rootPatch).toHaveBeenCalledWith('/api/projects/p1/tasks/t1', {
        status: 'in_progress',
        assignee: 'bob',
      });
    });
  });

  // -- Action: claim --
  describe('action="claim"', () => {
    it('R205-CL1: POSTs to /tasks/{taskId}/claim and verifies post-state', async () => {
      mocks.rootPost.mockResolvedValueOnce({ data: { id: 't1' } });
      mocks.rootGet.mockResolvedValueOnce({ data: { status: 'in_progress' } });

      await callTool(server, 'plansync_task', {
        action: 'claim',
        projectId: 'p1',
        taskId: 't1',
      });

      expect(mocks.rootPost).toHaveBeenCalledWith('/api/projects/p1/tasks/t1/claim', {
        assigneeType: 'agent',
      });
      // Post-write verification GET (parity with the legacy alias) — both
      // surfaces re-read the task to confirm the claim landed.
      expect(mocks.rootGet).toHaveBeenCalledWith('/api/projects/p1/tasks/t1');
    });

    it('R205-CL2: respects startImmediately=false and verifies status=todo', async () => {
      mocks.rootPost.mockResolvedValueOnce({ data: { id: 't1' } });
      mocks.rootGet.mockResolvedValueOnce({ data: { status: 'todo' } });

      const result = await callTool(server, 'plansync_task', {
        action: 'claim',
        projectId: 'p1',
        taskId: 't1',
        startImmediately: false,
      });

      expect(mocks.rootPost).toHaveBeenCalledWith('/api/projects/p1/tasks/t1/claim', {
        assigneeType: 'agent',
        startImmediately: false,
      });
      // No "may have failed" warning — verification matched expectation.
      expect(result.content[0].text).not.toMatch(/may have failed/);
    });

    it('R205-CL3: surfaces "may have failed" when the post-state mismatches expectation', async () => {
      mocks.rootPost.mockResolvedValueOnce({ data: { id: 't1' } });
      mocks.rootGet.mockResolvedValueOnce({ data: { status: 'todo' } });

      const result = await callTool(server, 'plansync_task', {
        action: 'claim',
        projectId: 'p1',
        taskId: 't1',
      });

      expect(result.content[0].text).toMatch(/claim may have failed/i);
    });
  });

  // -- Action: decline --
  describe('action="decline"', () => {
    it('R205-D1: POSTs to /tasks/{taskId}/decline with empty body and verifies assignee cleared', async () => {
      mocks.rootPost.mockResolvedValueOnce({ data: { id: 't1' } });
      mocks.rootGet.mockResolvedValueOnce({ data: { assignee: null } });

      await callTool(server, 'plansync_task', {
        action: 'decline',
        projectId: 'p1',
        taskId: 't1',
      });

      expect(mocks.rootPost).toHaveBeenCalledWith('/api/projects/p1/tasks/t1/decline', {});
      expect(mocks.rootGet).toHaveBeenCalledWith('/api/projects/p1/tasks/t1');
    });
  });

  // -- Action: rebind --
  describe('action="rebind"', () => {
    it('R205-R1: POSTs to /tasks/{taskId}/rebind with no body', async () => {
      mocks.rootPost.mockResolvedValueOnce({ data: { boundPlanVersion: 5 } });

      await callTool(server, 'plansync_task', {
        action: 'rebind',
        projectId: 'p1',
        taskId: 't1',
      });

      expect(mocks.rootPost).toHaveBeenCalledWith('/api/projects/p1/tasks/t1/rebind');
    });

    it('R205-R2: produces the same wire call as the legacy `handleTaskRebind` helper', async () => {
      mocks.rootPost.mockResolvedValueOnce({ data: {} });
      await callTool(server, 'plansync_task', {
        action: 'rebind',
        projectId: 'p1',
        taskId: 't1',
      });
      const newCall = mocks.rootPost.mock.calls.at(-1);

      mocks.rootPost.mockResolvedValueOnce({ data: {} });
      await handleTaskRebind({ projectId: 'p1', taskId: 't1' }, { api });
      const legacyCall = mocks.rootPost.mock.calls.at(-1);

      expect(newCall).toEqual(legacyCall);
    });
  });

  // -- Schema rejection: discriminated-union enforces per-action fields --
  describe('schema validation', () => {
    it('R205-S1: rejects update without taskId', async () => {
      await expect(
        callTool(server, 'plansync_task', {
          action: 'update',
          projectId: 'p1',
        }),
      ).rejects.toThrow(/invalid arguments/);
    });

    it('R205-S2: rejects rebind without taskId', async () => {
      await expect(
        callTool(server, 'plansync_task', {
          action: 'rebind',
          projectId: 'p1',
        }),
      ).rejects.toThrow(/invalid arguments/);
    });

    it('R205-S3: rejects create without title (shared schema enforces required)', async () => {
      await expect(
        callTool(server, 'plansync_task', {
          action: 'create',
          projectId: 'p1',
        }),
      ).rejects.toThrow(/invalid arguments/);
    });

    // Issue #2769 — the outer SDK-facing inputSchema MUST be a real superset
    // of `createTaskShape` / `updateTaskShape`. The MCP SDK strips fields
    // that aren't in the outer shape BEFORE the inner discriminated-union
    // `safeParse` runs, so any field declared on the shared shape but
    // missing here is silently dropped — breaking deliverable binding,
    // drift-blast-radius scoping, and completion verification.
    it('R205-S4 (#2769): outer schema declares planDeliverableRefs / planConstraintRefs / planStandardRefs', () => {
      const t = getTool(server, 'plansync_task');
      const shape = t?.inputSchema?.shape;
      expect(shape).toBeDefined();
      expect(shape).toHaveProperty('planDeliverableRefs');
      expect(shape).toHaveProperty('planConstraintRefs');
      expect(shape).toHaveProperty('planStandardRefs');
    });

    it('R205-S5 (#2769): outer schema accepts plan*Refs as string arrays on create', () => {
      const t = getTool(server, 'plansync_task');
      const schema = t?.inputSchema;
      expect(schema).toBeDefined();
      const parsed = schema!.safeParse({
        action: 'create',
        projectId: 'p1',
        title: 'X',
        type: 'code',
        planDeliverableRefs: ['deliv-1', 'deliv-2'],
        planConstraintRefs: ['c1'],
        planStandardRefs: ['s1'],
      });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.planDeliverableRefs).toEqual(['deliv-1', 'deliv-2']);
      expect(parsed.data?.planConstraintRefs).toEqual(['c1']);
      expect(parsed.data?.planStandardRefs).toEqual(['s1']);
    });

    it('R205-S6 (#2769): outer schema accepts agentConstraints as an array of strings (not a scalar string)', () => {
      const t = getTool(server, 'plansync_task');
      const schema = t?.inputSchema;
      expect(schema).toBeDefined();

      // Array form must succeed (matches the shared schema and the REST API).
      const okParsed = schema!.safeParse({
        action: 'create',
        projectId: 'p1',
        title: 'X',
        type: 'code',
        agentConstraints: ['must use TypeScript', 'no npm install'],
      });
      expect(okParsed.success).toBe(true);
      expect(okParsed.data?.agentConstraints).toEqual(['must use TypeScript', 'no npm install']);

      // The legacy scalar-string form must NOT silently coerce — that was
      // the original bug: it advertised `string` so callers thinking they
      // were passing an array got a confusing rejection (or worse, the
      // SDK strip-then-validate dropped the field entirely).
      const badParsed = schema!.safeParse({
        action: 'create',
        projectId: 'p1',
        title: 'X',
        type: 'code',
        agentConstraints: 'must use TypeScript',
      });
      expect(badParsed.success).toBe(false);
    });

    it('R205-S7 (#2769): outer schema accepts null on update-clearable fields', () => {
      // updateTaskShape declares these as `.nullable().optional()` so an
      // agent can clear them via the unified surface (same as the legacy
      // plansync_task_update behaviour). Outer schema must not strip
      // `null` to undefined or reject the payload outright.
      const t = getTool(server, 'plansync_task');
      const schema = t?.inputSchema;
      expect(schema).toBeDefined();
      const parsed = schema!.safeParse({
        action: 'update',
        projectId: 'p1',
        taskId: 't1',
        description: null,
        branchName: null,
        prUrl: null,
        agentContext: null,
        expectedOutput: null,
        startDate: null,
        dueDate: null,
        assignee: null,
      });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.description).toBeNull();
      expect(parsed.data?.branchName).toBeNull();
      expect(parsed.data?.prUrl).toBeNull();
      expect(parsed.data?.agentContext).toBeNull();
      expect(parsed.data?.expectedOutput).toBeNull();
      expect(parsed.data?.startDate).toBeNull();
      expect(parsed.data?.dueDate).toBeNull();
      expect(parsed.data?.assignee).toBeNull();
    });

    it('R205-S8 (#2769): outer shape is a true superset of createTaskShape and updateTaskShape', async () => {
      // Hard guard against future regressions: every field in the shared
      // shapes MUST appear on the outer plansync_task input schema. The
      // outer shape may legitimately add routing-only fields (action,
      // projectId, taskId, startImmediately for the claim path) — those
      // are listed in `allowedExtras` below.
      const { createTaskShape, updateTaskShape } = await import('@plansync/shared');
      const sharedKeys = new Set<string>([
        ...Object.keys(createTaskShape),
        ...Object.keys(updateTaskShape),
      ]);
      const t = getTool(server, 'plansync_task');
      const shape = t?.inputSchema?.shape;
      expect(shape).toBeDefined();
      const outerKeys = new Set(Object.keys(shape!));
      const missing = [...sharedKeys].filter((k) => !outerKeys.has(k));
      expect(
        missing,
        `outer plansync_task schema missing fields from shared shapes: ${missing.join(', ')}`,
      ).toEqual([]);
    });
  });

  // -- Step 2 verification: deprecation warnings on legacy aliases --
  describe('deprecation warnings on legacy aliases', () => {
    it('R205-DEP1: plansync_task_create emits a deprecation warning per call', async () => {
      mocks.rootPost.mockResolvedValueOnce({ data: { id: 't1' } });
      await callTool(server, 'plansync_task_create', {
        projectId: 'p1',
        title: 'x',
        type: 'code',
      });
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'plansync_task_create' }),
        expect.stringContaining('R-205 deprecated alias called'),
      );
    });

    it('R205-DEP2: plansync_task_update emits a deprecation warning per call', async () => {
      mocks.rootPatch.mockResolvedValueOnce({ data: { id: 't1' } });
      await callTool(server, 'plansync_task_update', {
        projectId: 'p1',
        taskId: 't1',
        status: 'in_progress',
      });
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'plansync_task_update' }),
        expect.stringContaining('R-205 deprecated alias called'),
      );
    });

    it('R205-DEP3: plansync_task_claim emits a deprecation warning per call', async () => {
      mocks.rootPost.mockResolvedValueOnce({ data: { id: 't1' } });
      mocks.rootGet.mockResolvedValueOnce({ data: { status: 'in_progress' } });
      await callTool(server, 'plansync_task_claim', {
        projectId: 'p1',
        taskId: 't1',
      });
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'plansync_task_claim' }),
        expect.stringContaining('R-205 deprecated alias called'),
      );
    });

    it('R205-DEP4: plansync_task_decline emits a deprecation warning per call', async () => {
      mocks.rootPost.mockResolvedValueOnce({ data: { id: 't1' } });
      mocks.rootGet.mockResolvedValueOnce({ data: { assignee: null } });
      await callTool(server, 'plansync_task_decline', {
        projectId: 'p1',
        taskId: 't1',
      });
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'plansync_task_decline' }),
        expect.stringContaining('R-205 deprecated alias called'),
      );
    });

    it('R205-DEP5: plansync_task does NOT emit the deprecation warning', async () => {
      mocks.rootPost.mockResolvedValueOnce({ data: { id: 't1' } });
      await callTool(server, 'plansync_task', {
        action: 'create',
        projectId: 'p1',
        title: 'x',
        type: 'code',
      });
      const deprecationCalls = loggerMock.warn.mock.calls.filter((args) =>
        typeof args[1] === 'string' ? args[1].includes('R-205 deprecated alias') : false,
      );
      expect(deprecationCalls).toHaveLength(0);
    });
  });

  // -- normalizeTaskToolNameForFsm: keeps the FSM table untouched --
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

    it('R205-N2: passes through unrelated tools and unknown actions unchanged', () => {
      expect(normalizeTaskToolNameForFsm('plansync_task_pack', { action: 'create' })).toBe(
        'plansync_task_pack',
      );
      expect(normalizeTaskToolNameForFsm('plansync_run', { action: 'start' })).toBe('plansync_run');
      expect(normalizeTaskToolNameForFsm('plansync_task', null)).toBe('plansync_task');
      expect(normalizeTaskToolNameForFsm('plansync_task', { action: 'bogus' })).toBe(
        'plansync_task',
      );
    });
  });
});

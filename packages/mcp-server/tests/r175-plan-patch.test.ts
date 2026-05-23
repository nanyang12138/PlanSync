/**
 * R-175 step 1 of 3: plansync_plan_patch collapses the four plansync_plan_*_append
 * tools into a single discriminated-union tool. The four old names stay as
 * deprecated aliases that forward to the same `applyPatches` helper.
 *
 * This test file covers:
 *
 *   1. The new plansync_plan_patch tool
 *      - single-patch happy path posts to /append with {field, items}
 *      - multi-patch batch posts in order, returns {applied, results} envelope
 *      - asAgent routes through withUser
 *      - schema rejects empty patches array
 *      - schema rejects >20 patches per call
 *      - schema rejects unknown field name
 *      - schema rejects empty items / >50 items per op (same caps as legacy)
 *
 *   2. Backward-compat aliases
 *      - each of the 4 old names is still registered
 *      - alias schema unchanged (projectId / planId / items / asAgent only)
 *      - alias forwards to the same /append endpoint with the matching field
 *      - alias description mentions [DEPRECATED]
 *      - alias asAgent routes through withUser
 *
 *   3. Parity with legacy R-121 behaviour (so the R-121 tests stay green
 *      even though the implementation underneath changed)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const mocks = vi.hoisted(() => {
  const rootPost = vi.fn();
  const delegatedPost = vi.fn();
  const withUser = vi.fn((_userName: string) => ({
    get: vi.fn(),
    post: delegatedPost,
    patch: vi.fn(),
    delete: vi.fn(),
    withUser,
  }));
  const getDelegationAgent = vi.fn<() => string | undefined>(() => undefined);
  return { rootPost, delegatedPost, withUser, getDelegationAgent };
});

vi.mock('../src/api-client', () => ({
  ApiClient: vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    post: mocks.rootPost,
    patch: vi.fn(),
    delete: vi.fn(),
    withUser: mocks.withUser,
  })),
}));

vi.mock('../src/tools/status', () => ({
  getDelegationAgent: mocks.getDelegationAgent,
  registerStatusTools: vi.fn(),
}));

const { rootPost, delegatedPost, withUser, getDelegationAgent: getDelegationAgentMock } = mocks;

import { ApiClient } from '../src/api-client';
import { registerPlanTools } from '../src/tools/plan';

const config = { apiBaseUrl: 'http://localhost:3001', apiToken: 'test', userName: 'owner' };

interface RegisteredTool {
  description?: string;
  inputSchema?: {
    safeParse: (input: unknown) => {
      success: boolean;
      error?: { issues: Array<{ path: (string | number)[] }> };
    };
  };
  callback?: (args: Record<string, unknown>) => Promise<unknown>;
  handler?: (args: Record<string, unknown>) => Promise<unknown>;
}

function getTool(server: McpServer, name: string): RegisteredTool | undefined {
  // @ts-expect-error — internal SDK shape
  const tools = (server as any)._registeredTools ?? (server as any)._tools ?? {};
  return tools[name];
}

function getToolHandler(
  server: McpServer,
  name: string,
): ((args: Record<string, unknown>) => Promise<unknown>) | undefined {
  const t = getTool(server, name);
  if (!t) return undefined;
  return t.callback ?? t.handler;
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const handler = getToolHandler(server, name);
  if (!handler) throw new Error(`Tool not found: ${name}`);
  return (await handler(args)) as { content: Array<{ type: string; text: string }> };
}

function getInputSchema(server: McpServer, name: string) {
  const t = getTool(server, name);
  return t?.inputSchema;
}

describe('R-175: plansync_plan_patch', () => {
  let server: McpServer;
  let api: ApiClient;

  beforeEach(() => {
    rootPost.mockReset();
    delegatedPost.mockReset();
    withUser.mockClear();
    getDelegationAgentMock.mockReset();
    getDelegationAgentMock.mockReturnValue(undefined);
    server = new McpServer({ name: 'test', version: '0.0.1' });
    api = new ApiClient(config);
    registerPlanTools(server, api, config);
  });

  describe('new tool surface', () => {
    it('R175-1: single append patch posts to /append with {field, items}', async () => {
      rootPost.mockResolvedValueOnce({ data: { added: 2, skipped: 0 } });

      const result = await callTool(server, 'plansync_plan_patch', {
        projectId: 'p1',
        planId: 'pl1',
        patches: [{ op: 'append', field: 'deliverables', items: ['a', 'b'] }],
      });

      expect(rootPost).toHaveBeenCalledTimes(1);
      expect(rootPost).toHaveBeenCalledWith('/api/projects/p1/plans/pl1/append', {
        field: 'deliverables',
        items: ['a', 'b'],
      });
      // Single-patch responses return the raw API result for backward-friendly shape.
      const payload = JSON.parse(result.content[0].text);
      expect(payload).toEqual({ data: { added: 2, skipped: 0 } });
    });

    it('R175-2: multi-patch batch posts each patch in order; returns envelope', async () => {
      rootPost
        .mockResolvedValueOnce({ data: { field: 'deliverables', added: 1 } })
        .mockResolvedValueOnce({ data: { field: 'constraints', added: 1 } })
        .mockResolvedValueOnce({ data: { field: 'standards', added: 1 } });

      const result = await callTool(server, 'plansync_plan_patch', {
        projectId: 'p1',
        planId: 'pl1',
        patches: [
          { op: 'append', field: 'deliverables', items: ['d1'] },
          { op: 'append', field: 'constraints', items: ['c1'] },
          { op: 'append', field: 'standards', items: ['s1'] },
        ],
      });

      expect(rootPost).toHaveBeenCalledTimes(3);
      expect(rootPost.mock.calls[0][1]).toEqual({ field: 'deliverables', items: ['d1'] });
      expect(rootPost.mock.calls[1][1]).toEqual({ field: 'constraints', items: ['c1'] });
      expect(rootPost.mock.calls[2][1]).toEqual({ field: 'standards', items: ['s1'] });

      const payload = JSON.parse(result.content[0].text);
      expect(payload.applied).toBe(3);
      expect(payload.results).toHaveLength(3);
    });

    it('R175-3: asAgent routes every patch in the batch through withUser', async () => {
      delegatedPost
        .mockResolvedValueOnce({ data: { added: 1 } })
        .mockResolvedValueOnce({ data: { added: 1 } });

      await callTool(server, 'plansync_plan_patch', {
        projectId: 'p1',
        planId: 'pl1',
        patches: [
          { op: 'append', field: 'deliverables', items: ['d1'] },
          { op: 'append', field: 'openQuestions', items: ['q1'] },
        ],
        asAgent: 'genie',
      });

      // One withUser per call (called once at top, batch reuses the same client).
      expect(withUser).toHaveBeenCalledWith('genie');
      expect(delegatedPost).toHaveBeenCalledTimes(2);
      expect(rootPost).not.toHaveBeenCalled();
    });

    it('R175-4: schema rejects empty patches array', () => {
      const schema = getInputSchema(server, 'plansync_plan_patch');
      expect(schema).toBeDefined();
      const res = schema!.safeParse({ projectId: 'p', planId: 'pl', patches: [] });
      expect(res.success).toBe(false);
      const paths = (res.error?.issues ?? []).map((i) => i.path.join('.'));
      expect(paths).toContain('patches');
    });

    it('R175-5: schema rejects >20 patches per call', () => {
      const schema = getInputSchema(server, 'plansync_plan_patch');
      const tooMany = Array.from({ length: 21 }, () => ({
        op: 'append' as const,
        field: 'deliverables' as const,
        items: ['x'],
      }));
      const res = schema!.safeParse({ projectId: 'p', planId: 'pl', patches: tooMany });
      expect(res.success).toBe(false);
    });

    it('R175-6: schema rejects unknown field name', () => {
      const schema = getInputSchema(server, 'plansync_plan_patch');
      const res = schema!.safeParse({
        projectId: 'p',
        planId: 'pl',
        patches: [{ op: 'append', field: 'not_a_field', items: ['x'] }],
      });
      expect(res.success).toBe(false);
    });

    it('R175-7: schema rejects empty items per patch', () => {
      const schema = getInputSchema(server, 'plansync_plan_patch');
      const res = schema!.safeParse({
        projectId: 'p',
        planId: 'pl',
        patches: [{ op: 'append', field: 'deliverables', items: [] }],
      });
      expect(res.success).toBe(false);
    });

    it('R175-8: schema rejects >50 items per patch (token-budget guard)', () => {
      const schema = getInputSchema(server, 'plansync_plan_patch');
      const tooMany = Array.from({ length: 51 }, (_, i) => `i${i}`);
      const res = schema!.safeParse({
        projectId: 'p',
        planId: 'pl',
        patches: [{ op: 'append', field: 'deliverables', items: tooMany }],
      });
      expect(res.success).toBe(false);
    });

    it('R175-9: tool description mentions plan_patch as the replacement surface', () => {
      const t = getTool(server, 'plansync_plan_patch');
      expect(t?.description).toMatch(/replaces|append/i);
      expect(t?.description).toMatch(/owner only/i);
    });
  });

  describe('deprecated aliases (one release of backward compat)', () => {
    const aliases: Array<{
      tool: string;
      field: 'deliverables' | 'constraints' | 'standards' | 'openQuestions';
    }> = [
      { tool: 'plansync_plan_deliverables_append', field: 'deliverables' },
      { tool: 'plansync_plan_constraints_append', field: 'constraints' },
      { tool: 'plansync_plan_standards_append', field: 'standards' },
      { tool: 'plansync_plan_open_questions_append', field: 'openQuestions' },
    ];

    for (const { tool, field } of aliases) {
      it(`R175-A-${field}: ${tool} still registered, forwards to /append with field=${field}`, async () => {
        rootPost.mockResolvedValueOnce({ data: { added: 1, skipped: 0 } });

        await callTool(server, tool, {
          projectId: 'p1',
          planId: 'pl1',
          items: ['item a'],
        });

        expect(rootPost).toHaveBeenCalledWith('/api/projects/p1/plans/pl1/append', {
          field,
          items: ['item a'],
        });
        expect(withUser).not.toHaveBeenCalled();
      });

      it(`R175-A-${field}-deprecated-flag: ${tool} description carries [DEPRECATED] marker`, () => {
        const t = getTool(server, tool);
        expect(t?.description).toMatch(/deprecated/i);
        expect(t?.description).toMatch(/plansync_plan_patch/);
      });

      it(`R175-A-${field}-asAgent: ${tool} routes through withUser when asAgent set`, async () => {
        delegatedPost.mockResolvedValueOnce({ data: {} });
        await callTool(server, tool, {
          projectId: 'p1',
          planId: 'pl1',
          items: ['x'],
          asAgent: 'genie',
        });
        expect(withUser).toHaveBeenCalledWith('genie');
        expect(delegatedPost).toHaveBeenCalledWith('/api/projects/p1/plans/pl1/append', {
          field,
          items: ['x'],
        });
        expect(rootPost).not.toHaveBeenCalled();
      });
    }

    it('R175-A-schema-unchanged: alias schema is still {projectId, planId, items, asAgent?} only', () => {
      const schema = getInputSchema(server, 'plansync_plan_deliverables_append');
      // Schema accepts the old shape — no `op` / `field` / `patches`.
      const ok = schema!.safeParse({ projectId: 'p', planId: 'pl', items: ['x'] });
      expect(ok.success).toBe(true);
      // And does NOT accept the new tool's shape, so callers don't accidentally
      // mix surfaces.
      const wrong = schema!.safeParse({
        projectId: 'p',
        planId: 'pl',
        patches: [{ op: 'append', field: 'deliverables', items: ['x'] }],
      });
      expect(wrong.success).toBe(false);
    });
  });

  describe('parity with legacy R-121 behaviour', () => {
    it('R175-P1: dup-skip semantics still live in the API (we forward whatever API returns)', async () => {
      rootPost.mockResolvedValueOnce({ data: { added: 1, skipped: 1 } });
      const result = await callTool(server, 'plansync_plan_constraints_append', {
        projectId: 'p1',
        planId: 'pl1',
        items: ['a', 'a'],
      });
      // Behaviour identical to R-121: caller gets the API envelope verbatim.
      expect(JSON.parse(result.content[0].text)).toEqual({ data: { added: 1, skipped: 1 } });
    });
  });
});

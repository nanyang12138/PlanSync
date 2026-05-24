// R-121: Unit tests for plansync_plan_activate / plan_reactivate /
// plan_*_append / plansync_review_approve / plansync_review_reject.
//
// These five MCP tools were previously only covered by a single happy-path
// assertion for plan_activate (M16 in mcp-tools.test.ts) and the R-038 schema
// tests for review_reject. The verification branches (post-mutation GET
// returning a non-final status), the append idempotency endpoint, and the
// review lookup-by-name dispatch all had no regression coverage. This file
// closes those gaps.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const mocks = vi.hoisted(() => {
  const rootGet = vi.fn();
  const rootPost = vi.fn();
  const rootPatch = vi.fn();
  const rootDelete = vi.fn();
  const delegatedGet = vi.fn();
  const delegatedPost = vi.fn();
  const delegatedPatch = vi.fn();
  const delegatedDelete = vi.fn();
  const withUser = vi.fn((_userName: string) => ({
    get: delegatedGet,
    post: delegatedPost,
    patch: delegatedPatch,
    delete: delegatedDelete,
    withUser,
  }));
  const getDelegationAgent = vi.fn<() => string | undefined>(() => undefined);
  return {
    rootGet,
    rootPost,
    rootPatch,
    rootDelete,
    delegatedGet,
    delegatedPost,
    delegatedPatch,
    delegatedDelete,
    withUser,
    getDelegationAgent,
  };
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

vi.mock('../src/tools/status', () => ({
  getDelegationAgent: mocks.getDelegationAgent,
  registerStatusTools: vi.fn(),
}));

const {
  rootGet,
  rootPost,
  delegatedGet,
  delegatedPost,
  withUser,
  getDelegationAgent: getDelegationAgentMock,
} = mocks;

import { ApiClient } from '../src/api-client';
import { registerPlanTools } from '../src/tools/plan';

const config = { apiBaseUrl: 'http://localhost:3001', apiToken: 'test', userName: 'owner' };

function makeServer() {
  return new McpServer({ name: 'test', version: '0.0.1' });
}

function getToolHandler(
  server: McpServer,
  name: string,
): ((args: Record<string, unknown>) => Promise<unknown>) | undefined {
  const tools =
    // @ts-expect-error - internal SDK structure not in type definitions
    (server as any)._registeredTools ?? (server as any)._tools ?? {};
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
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const handler = getToolHandler(server, name);
  if (!handler) throw new Error(`Tool not found: ${name}`);
  return (await handler(args)) as { content: Array<{ type: string; text: string }> };
}

function singleText(result: { content: Array<{ type: string; text: string }> }): string {
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  return result.content[0].text;
}

describe('R-121: MCP plan_activate / reactivate / append / review_* unit tests', () => {
  let server: McpServer;
  let api: ApiClient;

  beforeEach(() => {
    rootGet.mockReset();
    rootPost.mockReset();
    delegatedGet.mockReset();
    delegatedPost.mockReset();
    withUser.mockClear();
    getDelegationAgentMock.mockReset();
    getDelegationAgentMock.mockReturnValue(undefined);

    server = makeServer();
    api = new ApiClient(config);
    registerPlanTools(server, api, config);
  });

  describe('plansync_plan_activate', () => {
    it('M16+R121-A1: POSTs to /activate then verifies via GET; returns activation JSON on status=active', async () => {
      rootPost.mockResolvedValueOnce({ data: { id: 'pl1', status: 'active' } });
      rootGet.mockResolvedValueOnce({ data: { status: 'active' } });

      const result = await callTool(server, 'plansync_plan_activate', {
        projectId: 'p1',
        planId: 'pl1',
      });

      expect(rootPost).toHaveBeenCalledWith('/api/projects/p1/plans/pl1/activate', {});
      expect(rootGet).toHaveBeenCalledWith('/api/projects/p1/plans/pl1');
      const text = singleText(result);
      expect(text).toContain('"status": "active"');
      expect(text).not.toContain('may have failed');
      expect(withUser).not.toHaveBeenCalled();
    });

    it('R121-A2: returns warning text when verify GET still shows non-active status', async () => {
      rootPost.mockResolvedValueOnce({ data: { id: 'pl1' } });
      rootGet.mockResolvedValueOnce({ data: { status: 'proposed' } });

      const result = await callTool(server, 'plansync_plan_activate', {
        projectId: 'p1',
        planId: 'pl1',
      });

      const text = singleText(result);
      // Must surface both the observed status and the failure hint so the
      // caller (an LLM-driven session) does not falsely report success.
      expect(text).toContain('still "proposed"');
      expect(text).toContain('may have failed');
    });

    it('R121-A3: when asAgent is provided, both POST and verify GET go through api.withUser', async () => {
      delegatedPost.mockResolvedValueOnce({ data: { id: 'pl1', status: 'active' } });
      delegatedGet.mockResolvedValueOnce({ data: { status: 'active' } });

      await callTool(server, 'plansync_plan_activate', {
        projectId: 'p1',
        planId: 'pl1',
        asAgent: 'genie',
      });

      expect(withUser).toHaveBeenCalledWith('genie');
      expect(delegatedPost).toHaveBeenCalledWith('/api/projects/p1/plans/pl1/activate', {});
      expect(delegatedGet).toHaveBeenCalledWith('/api/projects/p1/plans/pl1');
      // Root client must not be used in delegation mode
      expect(rootPost).not.toHaveBeenCalled();
      expect(rootGet).not.toHaveBeenCalled();
    });

    it('R205-A1: force=true appends ?force=true to the activate URL', async () => {
      rootPost.mockResolvedValueOnce({ data: { id: 'pl1', status: 'active' } });
      rootGet.mockResolvedValueOnce({ data: { status: 'active' } });

      await callTool(server, 'plansync_plan_activate', {
        projectId: 'p1',
        planId: 'pl1',
        force: true,
      });

      expect(rootPost).toHaveBeenCalledWith('/api/projects/p1/plans/pl1/activate?force=true', {});
      expect(rootGet).toHaveBeenCalledWith('/api/projects/p1/plans/pl1');
    });

    it('R205-A2: force=false (default) leaves the URL clean', async () => {
      rootPost.mockResolvedValueOnce({ data: { id: 'pl1', status: 'active' } });
      rootGet.mockResolvedValueOnce({ data: { status: 'active' } });

      await callTool(server, 'plansync_plan_activate', {
        projectId: 'p1',
        planId: 'pl1',
        force: false,
      });

      expect(rootPost).toHaveBeenCalledWith('/api/projects/p1/plans/pl1/activate', {});
    });

    it('R205-A3: force flag is propagated through delegation (asAgent)', async () => {
      delegatedPost.mockResolvedValueOnce({ data: { id: 'pl1', status: 'active' } });
      delegatedGet.mockResolvedValueOnce({ data: { status: 'active' } });

      await callTool(server, 'plansync_plan_activate', {
        projectId: 'p1',
        planId: 'pl1',
        force: true,
        asAgent: 'genie',
      });

      expect(withUser).toHaveBeenCalledWith('genie');
      expect(delegatedPost).toHaveBeenCalledWith(
        '/api/projects/p1/plans/pl1/activate?force=true',
        {},
      );
      expect(rootPost).not.toHaveBeenCalled();
    });
  });

  describe('plansync_plan_withdraw (R-205)', () => {
    it('R205-W1: POSTs to /withdraw then verifies the plan is back to draft', async () => {
      rootPost.mockResolvedValueOnce({ data: { id: 'pl1', status: 'draft' } });
      rootGet.mockResolvedValueOnce({ data: { status: 'draft' } });

      const result = await callTool(server, 'plansync_plan_withdraw', {
        projectId: 'p1',
        planId: 'pl1',
      });

      expect(rootPost).toHaveBeenCalledWith('/api/projects/p1/plans/pl1/withdraw', {});
      expect(rootGet).toHaveBeenCalledWith('/api/projects/p1/plans/pl1');
      const text = singleText(result);
      expect(text).toContain('"status": "draft"');
      expect(text).not.toContain('may have failed');
    });

    it('R205-W2: warns when the verify GET still shows a non-draft status', async () => {
      rootPost.mockResolvedValueOnce({ data: { id: 'pl1' } });
      rootGet.mockResolvedValueOnce({ data: { status: 'proposed' } });

      const result = await callTool(server, 'plansync_plan_withdraw', {
        projectId: 'p1',
        planId: 'pl1',
      });

      const text = singleText(result);
      expect(text).toContain('still "proposed"');
      expect(text).toContain('may have failed');
    });

    it('R205-W3: asAgent routes both calls through api.withUser', async () => {
      delegatedPost.mockResolvedValueOnce({ data: { id: 'pl1' } });
      delegatedGet.mockResolvedValueOnce({ data: { status: 'draft' } });

      await callTool(server, 'plansync_plan_withdraw', {
        projectId: 'p1',
        planId: 'pl1',
        asAgent: 'genie',
      });

      expect(withUser).toHaveBeenCalledWith('genie');
      expect(delegatedPost).toHaveBeenCalledWith('/api/projects/p1/plans/pl1/withdraw', {});
      expect(delegatedGet).toHaveBeenCalledWith('/api/projects/p1/plans/pl1');
      expect(rootPost).not.toHaveBeenCalled();
    });
  });

  describe('plansync_plan_reactivate', () => {
    it('R121-R1: POSTs to /reactivate then verifies via GET; returns JSON on status=active', async () => {
      rootPost.mockResolvedValueOnce({ data: { id: 'pl1', status: 'active' } });
      rootGet.mockResolvedValueOnce({ data: { status: 'active' } });

      const result = await callTool(server, 'plansync_plan_reactivate', {
        projectId: 'p1',
        planId: 'pl1',
      });

      expect(rootPost).toHaveBeenCalledWith('/api/projects/p1/plans/pl1/reactivate', {});
      expect(rootGet).toHaveBeenCalledWith('/api/projects/p1/plans/pl1');
      const text = singleText(result);
      expect(text).toContain('"status": "active"');
      expect(text).not.toContain('rollback may have failed');
    });

    it('R121-R2: returns rollback-failed warning text when verify GET shows non-active status', async () => {
      rootPost.mockResolvedValueOnce({ data: {} });
      rootGet.mockResolvedValueOnce({ data: { status: 'superseded' } });

      const result = await callTool(server, 'plansync_plan_reactivate', {
        projectId: 'p1',
        planId: 'pl1',
      });

      const text = singleText(result);
      expect(text).toContain('still "superseded"');
      expect(text).toContain('rollback may have failed');
    });

    it('R121-R3: returns "unknown" placeholder when verify GET has no status field', async () => {
      rootPost.mockResolvedValueOnce({ data: {} });
      rootGet.mockResolvedValueOnce({ data: {} });

      const result = await callTool(server, 'plansync_plan_reactivate', {
        projectId: 'p1',
        planId: 'pl1',
      });

      const text = singleText(result);
      expect(text).toContain('still "unknown"');
    });

    it('R121-R4: asAgent routes both calls through api.withUser', async () => {
      delegatedPost.mockResolvedValueOnce({ data: { id: 'pl1' } });
      delegatedGet.mockResolvedValueOnce({ data: { status: 'active' } });

      await callTool(server, 'plansync_plan_reactivate', {
        projectId: 'p1',
        planId: 'pl1',
        asAgent: 'genie',
      });

      expect(withUser).toHaveBeenCalledWith('genie');
      expect(delegatedPost).toHaveBeenCalledWith('/api/projects/p1/plans/pl1/reactivate', {});
      expect(delegatedGet).toHaveBeenCalledWith('/api/projects/p1/plans/pl1');
      expect(rootPost).not.toHaveBeenCalled();
    });
  });

  describe('plansync_plan_*_append (deliverables / constraints / standards / openQuestions)', () => {
    const cases: Array<{
      tool: string;
      field: 'deliverables' | 'constraints' | 'standards' | 'openQuestions';
    }> = [
      { tool: 'plansync_plan_deliverables_append', field: 'deliverables' },
      { tool: 'plansync_plan_constraints_append', field: 'constraints' },
      { tool: 'plansync_plan_standards_append', field: 'standards' },
      { tool: 'plansync_plan_open_questions_append', field: 'openQuestions' },
    ];

    for (const { tool, field } of cases) {
      it(`R121-AP-${field}: ${tool} POSTs to /append with {field:"${field}", items}`, async () => {
        rootPost.mockResolvedValueOnce({ data: { skipped: 0, added: 2 } });

        await callTool(server, tool, {
          projectId: 'p1',
          planId: 'pl1',
          items: ['item a', 'item b'],
        });

        expect(rootPost).toHaveBeenCalledWith('/api/projects/p1/plans/pl1/append', {
          field,
          items: ['item a', 'item b'],
        });
        expect(withUser).not.toHaveBeenCalled();
      });
    }

    it('R121-AP-asAgent: deliverables_append routes through withUser when asAgent set', async () => {
      delegatedPost.mockResolvedValueOnce({ data: {} });

      await callTool(server, 'plansync_plan_deliverables_append', {
        projectId: 'p1',
        planId: 'pl1',
        items: ['x'],
        asAgent: 'genie',
      });

      expect(withUser).toHaveBeenCalledWith('genie');
      expect(delegatedPost).toHaveBeenCalledWith('/api/projects/p1/plans/pl1/append', {
        field: 'deliverables',
        items: ['x'],
      });
      expect(rootPost).not.toHaveBeenCalled();
    });

    it('R121-AP-schema-empty: rejects empty items array (min 1)', () => {
      const schema = getToolInputSchema(server, 'plansync_plan_deliverables_append');
      expect(schema).toBeDefined();
      const result = schema!.safeParse({ projectId: 'p1', planId: 'pl1', items: [] });
      expect(result.success).toBe(false);
      const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'));
      expect(paths).toContain('items');
    });

    it('R121-AP-schema-max: rejects >50 items (token-budget guard)', () => {
      const schema = getToolInputSchema(server, 'plansync_plan_constraints_append');
      expect(schema).toBeDefined();
      const tooMany = Array.from({ length: 51 }, (_, i) => `c${i}`);
      const result = schema!.safeParse({ projectId: 'p1', planId: 'pl1', items: tooMany });
      expect(result.success).toBe(false);
      const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'));
      expect(paths).toContain('items');
    });

    it('R121-AP-schema-empty-string: rejects items containing empty strings', () => {
      const schema = getToolInputSchema(server, 'plansync_plan_standards_append');
      expect(schema).toBeDefined();
      const result = schema!.safeParse({ projectId: 'p1', planId: 'pl1', items: ['ok', ''] });
      expect(result.success).toBe(false);
    });
  });

  describe('plansync_review_approve', () => {
    it('R121-RA1: looks up review by config.userName, POSTs with action=approve and comment', async () => {
      rootGet.mockResolvedValueOnce({
        data: [
          { id: 'rev-other', reviewerName: 'alice' },
          { id: 'rev-mine', reviewerName: 'owner' },
        ],
      });
      rootPost.mockResolvedValueOnce({ data: { status: 'approved' } });

      const result = await callTool(server, 'plansync_review_approve', {
        projectId: 'p1',
        planId: 'pl1',
        comment: 'LGTM',
      });

      expect(rootGet).toHaveBeenCalledWith('/api/projects/p1/plans/pl1/reviews');
      expect(rootPost).toHaveBeenCalledWith(
        '/api/projects/p1/plans/pl1/reviews/rev-mine?action=approve',
        { comment: 'LGTM' },
      );
      const text = singleText(result);
      expect(text).toContain('"status": "approved"');
    });

    it('R121-RA2: asUser overrides session user when looking up review row', async () => {
      rootGet.mockResolvedValueOnce({
        data: [
          { id: 'rev-owner', reviewerName: 'owner' },
          { id: 'rev-genie', reviewerName: 'genie' },
        ],
      });
      rootPost.mockResolvedValueOnce({ data: { status: 'approved' } });

      await callTool(server, 'plansync_review_approve', {
        projectId: 'p1',
        planId: 'pl1',
        asUser: 'genie',
      });

      // Must dispatch to the genie row, not owner's. comment is undefined when omitted.
      expect(rootPost).toHaveBeenCalledWith(
        '/api/projects/p1/plans/pl1/reviews/rev-genie?action=approve',
        { comment: undefined },
      );
    });

    it('R121-RA3: when asUser is absent but delegation agent is active, uses delegation agent', async () => {
      getDelegationAgentMock.mockReturnValue('genie');
      rootGet.mockResolvedValueOnce({
        data: [
          { id: 'rev-owner', reviewerName: 'owner' },
          { id: 'rev-genie', reviewerName: 'genie' },
        ],
      });
      rootPost.mockResolvedValueOnce({ data: { status: 'approved' } });

      await callTool(server, 'plansync_review_approve', { projectId: 'p1', planId: 'pl1' });

      expect(rootPost).toHaveBeenCalledWith(
        '/api/projects/p1/plans/pl1/reviews/rev-genie?action=approve',
        { comment: undefined },
      );
    });

    it('R121-RA4: throws when no review matches the target user', async () => {
      rootGet.mockResolvedValueOnce({
        data: [{ id: 'rev-other', reviewerName: 'someoneElse' }],
      });

      await expect(
        callTool(server, 'plansync_review_approve', { projectId: 'p1', planId: 'pl1' }),
      ).rejects.toThrow(/No pending review found for user "owner"/);
      expect(rootPost).not.toHaveBeenCalled();
    });
  });

  describe('plansync_review_reject', () => {
    it('R121-RR1: looks up review by config.userName, POSTs with action=reject and required comment', async () => {
      rootGet.mockResolvedValueOnce({
        data: [{ id: 'rev-mine', reviewerName: 'owner' }],
      });
      rootPost.mockResolvedValueOnce({ data: { status: 'rejected' } });

      const result = await callTool(server, 'plansync_review_reject', {
        projectId: 'p1',
        planId: 'pl1',
        comment: 'scope mismatch with task #4',
      });

      expect(rootGet).toHaveBeenCalledWith('/api/projects/p1/plans/pl1/reviews');
      expect(rootPost).toHaveBeenCalledWith(
        '/api/projects/p1/plans/pl1/reviews/rev-mine?action=reject',
        { comment: 'scope mismatch with task #4' },
      );
      const text = singleText(result);
      expect(text).toContain('"status": "rejected"');
    });

    it('R121-RR2: asUser overrides session user when looking up review row', async () => {
      rootGet.mockResolvedValueOnce({
        data: [
          { id: 'rev-owner', reviewerName: 'owner' },
          { id: 'rev-genie', reviewerName: 'genie' },
        ],
      });
      rootPost.mockResolvedValueOnce({ data: { status: 'rejected' } });

      await callTool(server, 'plansync_review_reject', {
        projectId: 'p1',
        planId: 'pl1',
        comment: 'security gap',
        asUser: 'genie',
      });

      expect(rootPost).toHaveBeenCalledWith(
        '/api/projects/p1/plans/pl1/reviews/rev-genie?action=reject',
        { comment: 'security gap' },
      );
    });

    it('R121-RR3: throws when no review matches the target user', async () => {
      rootGet.mockResolvedValueOnce({
        data: [{ id: 'rev-other', reviewerName: 'someoneElse' }],
      });

      await expect(
        callTool(server, 'plansync_review_reject', {
          projectId: 'p1',
          planId: 'pl1',
          comment: 'no',
        }),
      ).rejects.toThrow(/No pending review found for user "owner"/);
      expect(rootPost).not.toHaveBeenCalled();
    });

    it('R121-RR4: schema rejects missing comment (already enforced by R-038; re-asserted for R-121 coverage)', () => {
      const schema = getToolInputSchema(server, 'plansync_review_reject');
      expect(schema).toBeDefined();
      const result = schema!.safeParse({ projectId: 'p1', planId: 'pl1' });
      expect(result.success).toBe(false);
      const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'));
      expect(paths).toContain('comment');
    });
  });
});

// R-155: unit tests for the `plansync_deliverable_*` MCP tool surface and the
// extended `plansync_plan_suggest` schema (now accepts `deliverableId?`).
//
// Each tool is registered on a fresh in-process McpServer; the underlying
// ApiClient is fully mocked so we assert (a) URL + body shape, (b) routing
// through `withUser(asAgent)` for owner-only tools, and (c) input schema
// validation (slug regex, required keys, supersede shape).
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
  getDelegationAgent: vi.fn(() => undefined),
  registerStatusTools: vi.fn(),
}));

import { ApiClient } from '../src/api-client';
import { registerDeliverableTools } from '../src/tools/deliverable';
import { registerSuggestionTools } from '../src/tools/suggestion';

const {
  rootGet,
  rootPost,
  rootPatch,
  delegatedPost,
  delegatedPatch,
  withUser,
} = mocks;

type ToolEntry = {
  callback?: (...a: unknown[]) => Promise<unknown>;
  handler?: (...a: unknown[]) => Promise<unknown>;
  inputSchema?: {
    shape: Record<string, unknown>;
    safeParse: (input: unknown) => {
      success: boolean;
      error?: { issues: Array<{ path: (string | number)[]; message: string }> };
    };
  };
};

function getTool(server: McpServer, name: string): ToolEntry {
  const tools = (
    server as unknown as { _registeredTools: Record<string, ToolEntry> }
  )._registeredTools;
  const t = tools[name];
  if (!t) throw new Error(`Tool ${name} not registered`);
  return t;
}

function getToolHandler(
  server: McpServer,
  name: string,
): (args: Record<string, unknown>) => Promise<unknown> {
  const t = getTool(server, name);
  const fn = t.callback ?? t.handler;
  if (!fn) throw new Error(`Tool ${name} has no callback`);
  return fn as (args: Record<string, unknown>) => Promise<unknown>;
}

function makeServer(): McpServer {
  return new McpServer({ name: 'test', version: '0.0.1' });
}

function makeApi(): ApiClient {
  return new ApiClient({
    apiBaseUrl: 'http://localhost:3001',
    apiToken: 'test',
    userName: 'tester',
  });
}

describe('R-155: plansync_deliverable_* MCP tools', () => {
  let server: McpServer;
  let api: ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeServer();
    api = makeApi();
    registerDeliverableTools(server, api);
    registerSuggestionTools(server, api);
  });

  it('list: builds query string and GETs the canonical URL', async () => {
    rootGet.mockResolvedValueOnce({ data: [] });
    const handler = getToolHandler(server, 'plansync_deliverable_list');
    const out = await handler({
      projectId: 'proj',
      planId: 'plan',
      status: 'active',
      refType: 'file_glob',
    });
    expect(rootGet).toHaveBeenCalledWith(
      '/api/projects/proj/plans/plan/deliverables?status=active&refType=file_glob',
    );
    expect((out as { content: Array<{ text: string }> }).content[0].text).toContain('"data"');
  });

  it('list: omits query string when no filters are supplied', async () => {
    rootGet.mockResolvedValueOnce({ data: [] });
    const handler = getToolHandler(server, 'plansync_deliverable_list');
    await handler({ projectId: 'proj', planId: 'plan' });
    expect(rootGet).toHaveBeenCalledWith('/api/projects/proj/plans/plan/deliverables');
  });

  it('show: GETs the single-row URL', async () => {
    rootGet.mockResolvedValueOnce({ data: { id: 'd1' } });
    const handler = getToolHandler(server, 'plansync_deliverable_show');
    await handler({ projectId: 'proj', planId: 'plan', deliverableId: 'd1' });
    expect(rootGet).toHaveBeenCalledWith('/api/projects/proj/plans/plan/deliverables/d1');
  });

  it('create: POSTs only body fields (asAgent stripped) to the collection URL', async () => {
    rootPost.mockResolvedValueOnce({ data: { id: 'd2' } });
    const handler = getToolHandler(server, 'plansync_deliverable_create');
    await handler({
      projectId: 'proj',
      planId: 'plan',
      slug: 'auth/oidc',
      title: 'OIDC',
      refType: 'file_glob',
      refUri: 'src/auth/**/*.ts',
    });
    expect(rootPost).toHaveBeenCalledWith('/api/projects/proj/plans/plan/deliverables', {
      slug: 'auth/oidc',
      title: 'OIDC',
      refType: 'file_glob',
      refUri: 'src/auth/**/*.ts',
    });
  });

  it('create: routes through withUser(asAgent) when asAgent is set', async () => {
    delegatedPost.mockResolvedValueOnce({ data: { id: 'd3' } });
    const handler = getToolHandler(server, 'plansync_deliverable_create');
    await handler({
      projectId: 'proj',
      planId: 'plan',
      slug: 'a',
      title: 'A',
      asAgent: 'alice',
    });
    expect(withUser).toHaveBeenCalledWith('alice');
    expect(delegatedPost).toHaveBeenCalledWith(
      '/api/projects/proj/plans/plan/deliverables',
      { slug: 'a', title: 'A' },
    );
    expect(rootPost).not.toHaveBeenCalled();
  });

  it('update: PATCHes the single-row URL with the body fields', async () => {
    rootPatch.mockResolvedValueOnce({ data: { id: 'd1' } });
    const handler = getToolHandler(server, 'plansync_deliverable_update');
    await handler({
      projectId: 'proj',
      planId: 'plan',
      deliverableId: 'd1',
      title: 'new title',
      status: 'done',
    });
    expect(rootPatch).toHaveBeenCalledWith(
      '/api/projects/proj/plans/plan/deliverables/d1',
      { title: 'new title', status: 'done' },
    );
  });

  it('update: routes through withUser(asAgent) for delegated updates', async () => {
    delegatedPatch.mockResolvedValueOnce({ data: { id: 'd1' } });
    const handler = getToolHandler(server, 'plansync_deliverable_update');
    await handler({
      projectId: 'proj',
      planId: 'plan',
      deliverableId: 'd1',
      title: 't',
      asAgent: 'bob',
    });
    expect(withUser).toHaveBeenCalledWith('bob');
    expect(delegatedPatch).toHaveBeenCalledWith(
      '/api/projects/proj/plans/plan/deliverables/d1',
      { title: 't' },
    );
    expect(rootPatch).not.toHaveBeenCalled();
  });

  it('supersede: POSTs newDeliverableId to the .../supersede URL', async () => {
    rootPost.mockResolvedValueOnce({ data: { id: 'd1', supersededById: 'd2' } });
    const handler = getToolHandler(server, 'plansync_deliverable_supersede');
    await handler({
      projectId: 'proj',
      planId: 'plan',
      deliverableId: 'd1',
      newDeliverableId: 'd2',
    });
    expect(rootPost).toHaveBeenCalledWith(
      '/api/projects/proj/plans/plan/deliverables/d1/supersede',
      { newDeliverableId: 'd2' },
    );
  });

  it('input schema: deliverable_create rejects invalid slugs (regex)', () => {
    const tool = getTool(server, 'plansync_deliverable_create');
    expect(tool.inputSchema).toBeDefined();
    const bad = tool.inputSchema!.safeParse({
      projectId: 'p',
      planId: 'p',
      slug: 'Auth/OIDC',
      title: 't',
    });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.some((i) => i.path.includes('slug'))).toBe(true);
  });

  it('input schema: deliverable_create accepts a valid lowercase namespaced slug', () => {
    const tool = getTool(server, 'plansync_deliverable_create');
    const ok = tool.inputSchema!.safeParse({
      projectId: 'p',
      planId: 'p',
      slug: 'auth/oidc-callback',
      title: 'OK',
    });
    expect(ok.success).toBe(true);
  });

  it('input schema: deliverable_supersede requires newDeliverableId', () => {
    const tool = getTool(server, 'plansync_deliverable_supersede');
    const miss = tool.inputSchema!.safeParse({
      projectId: 'p',
      planId: 'p',
      deliverableId: 'd1',
    });
    expect(miss.success).toBe(false);
    expect(
      miss.error?.issues.some((i) => i.path.includes('newDeliverableId')),
    ).toBe(true);
  });

  it('plansync_plan_suggest now accepts optional deliverableId and forwards it', async () => {
    rootPost.mockResolvedValueOnce({ data: { id: 's1', deliverableId: 'd9' } });
    const handler = getToolHandler(server, 'plansync_plan_suggest');
    await handler({
      projectId: 'proj',
      planId: 'plan',
      field: 'deliverables',
      action: 'append',
      value: 'add rotation',
      reason: 'security review',
      deliverableId: 'd9',
    });
    expect(rootPost).toHaveBeenCalledWith('/api/projects/proj/plans/plan/suggestions', {
      field: 'deliverables',
      action: 'append',
      value: 'add rotation',
      reason: 'security review',
      deliverableId: 'd9',
    });
  });

  it('plansync_plan_suggest deliverableId is optional (backwards compatible)', async () => {
    rootPost.mockResolvedValueOnce({ data: { id: 's2' } });
    const handler = getToolHandler(server, 'plansync_plan_suggest');
    await handler({
      projectId: 'proj',
      planId: 'plan',
      field: 'goal',
      action: 'set',
      value: 'new goal',
      reason: 'better',
    });
    expect(rootPost).toHaveBeenCalledWith('/api/projects/proj/plans/plan/suggestions', {
      field: 'goal',
      action: 'set',
      value: 'new goal',
      reason: 'better',
    });
  });
});

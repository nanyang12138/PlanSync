// M module: MCP tool business logic (via mock ApiClient)
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Mock ApiClient before importing tools
const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPatch = vi.fn();
const mockDelete = vi.fn();

vi.mock('../src/api-client', () => ({
  ApiClient: vi.fn().mockImplementation(() => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    delete: mockDelete,
  })),
}));

import { ApiClient } from '../src/api-client';
import { registerProjectTools } from '../src/tools/project';
import { registerMemberTools } from '../src/tools/member';
import { registerPlanTools } from '../src/tools/plan';
import { registerTaskTools } from '../src/tools/task';
import { registerDriftTools } from '../src/tools/drift';
import { registerSuggestionTools } from '../src/tools/suggestion';
import { registerCommentTools } from '../src/tools/comment';
import { registerStatusTools } from '../src/tools/status';

const config = { apiBaseUrl: 'http://localhost:3001', apiToken: 'test', userName: 'alice' };

function makeServer() {
  return new McpServer({ name: 'test', version: '0.0.1' });
}

// Access the registered tool handler via MCP SDK's internal structure
function getToolHandler(
  server: McpServer,
  name: string,
): ((...args: unknown[]) => unknown) | undefined {
  // @ts-expect-error - internal SDK structure not in type definitions
  const tools = (server as any)._registeredTools ?? (server as any)._tools ?? {};
  if (tools[name]) {
    return tools[name].callback ?? tools[name].handler ?? tools[name];
  }
  return undefined;
}

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  const handler = getToolHandler(server, name);
  if (!handler) {
    throw new Error(
      `Tool not found: ${name}. Available: ${JSON.stringify(Object.keys((server as any)._registeredTools ?? {}))}`,
    );
  }
  return handler(args);
}

describe('M: MCP Tools (Unit, mock ApiClient)', () => {
  let api: ApiClient;

  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPatch.mockReset();
    mockDelete.mockReset();
  });

  describe('M1-M5: Project tools', () => {
    let server: McpServer;
    beforeEach(() => {
      server = makeServer();
      api = new ApiClient(config);
      registerProjectTools(server, api);
    });

    it('M1: plansync_project_create → POST /api/projects', async () => {
      mockPost.mockResolvedValue({ data: { id: 'p1', name: 'Test' } });
      await callTool(server, 'plansync_project_create', { name: 'Test', phase: 'planning' });
      expect(mockPost).toHaveBeenCalledWith(
        '/api/projects',
        expect.objectContaining({ name: 'Test' }),
      );
    });

    it('M2: plansync_project_list → GET /api/projects', async () => {
      mockGet.mockResolvedValue({ data: [] });
      await callTool(server, 'plansync_project_list', {});
      expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('/api/projects'));
    });

    it('M3: plansync_project_show → GET /api/projects/:id', async () => {
      mockGet.mockResolvedValue({ data: { id: 'p1' } });
      await callTool(server, 'plansync_project_show', { projectId: 'p1' });
      expect(mockGet).toHaveBeenCalledWith('/api/projects/p1');
    });

    it('M5: plansync_project_update → PATCH /api/projects/:id', async () => {
      mockPatch.mockResolvedValue({ data: { id: 'p1' } });
      await callTool(server, 'plansync_project_update', { projectId: 'p1', name: 'Updated' });
      expect(mockPatch).toHaveBeenCalledWith(
        '/api/projects/p1',
        expect.objectContaining({ name: 'Updated' }),
      );
    });
  });

  describe('M6-M9: Member tools', () => {
    let server: McpServer;
    beforeEach(() => {
      server = makeServer();
      api = new ApiClient(config);
      registerMemberTools(server, api);
    });

    it('M6: plansync_member_add → POST /api/projects/:id/members', async () => {
      mockPost.mockResolvedValue({ data: { id: 'm1', name: 'bob' } });
      await callTool(server, 'plansync_member_add', {
        projectId: 'p1',
        name: 'bob',
        role: 'developer',
      });
      expect(mockPost).toHaveBeenCalledWith(
        '/api/projects/p1/members',
        expect.objectContaining({ name: 'bob' }),
      );
    });

    it('M7: plansync_member_list → GET /api/projects/:id/members', async () => {
      mockGet.mockResolvedValue({ data: [] });
      await callTool(server, 'plansync_member_list', { projectId: 'p1' });
      expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('/api/projects/p1/members'));
    });

    it('M8: plansync_member_update → looks up by name then PATCH', async () => {
      mockGet.mockResolvedValue({ data: [{ id: 'm1', name: 'alice' }] });
      mockPatch.mockResolvedValue({ data: { id: 'm1' } });
      await callTool(server, 'plansync_member_update', {
        projectId: 'p1',
        name: 'alice',
        role: 'owner',
      });
      expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('/members'));
      expect(mockPatch).toHaveBeenCalledWith(expect.stringContaining('/m1'), expect.any(Object));
    });

    it('M9: plansync_member_remove → looks up by name then DELETE', async () => {
      mockGet.mockResolvedValue({ data: [{ id: 'm2', name: 'bob' }] });
      mockDelete.mockResolvedValue({ data: { deleted: true } });
      await callTool(server, 'plansync_member_remove', { projectId: 'p1', name: 'bob' });
      expect(mockDelete).toHaveBeenCalledWith(expect.stringContaining('/m2'));
    });
  });

  describe('M10-M19: Plan tools', () => {
    let server: McpServer;
    beforeEach(() => {
      server = makeServer();
      api = new ApiClient(config);
      registerPlanTools(server, api, config);
    });

    it('M10: plansync_plan_list → GET /api/projects/:id/plans', async () => {
      mockGet.mockResolvedValue({ data: [] });
      await callTool(server, 'plansync_plan_list', { projectId: 'p1' });
      expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('/api/projects/p1/plans'));
    });

    it('M12: plansync_plan_active → GET /api/projects/:id/plans/active', async () => {
      mockGet.mockResolvedValue({ data: null });
      await callTool(server, 'plansync_plan_active', { projectId: 'p1' });
      expect(mockGet).toHaveBeenCalledWith('/api/projects/p1/plans/active');
    });

    it('M13: plansync_plan_create → POST /api/projects/:id/plans', async () => {
      mockPost.mockResolvedValue({ data: { id: 'pl1' } });
      await callTool(server, 'plansync_plan_create', {
        projectId: 'p1',
        title: 'Plan 1',
        goal: 'g',
        scope: 's',
      });
      expect(mockPost).toHaveBeenCalledWith(
        '/api/projects/p1/plans',
        expect.objectContaining({ title: 'Plan 1' }),
      );
    });

    it('M16: plansync_plan_activate → POST /activate', async () => {
      mockPost.mockResolvedValue({ data: { status: 'active' } });
      await callTool(server, 'plansync_plan_activate', { projectId: 'p1', planId: 'pl1' });
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringContaining('/activate'),
        expect.any(Object),
      );
    });
  });

  describe('M20-M26: Suggestion + Comment tools', () => {
    let server: McpServer;
    beforeEach(() => {
      server = makeServer();
      api = new ApiClient(config);
      registerSuggestionTools(server, api);
      registerCommentTools(server, api);
    });

    it('M20: plansync_plan_suggest → POST suggestions', async () => {
      mockPost.mockResolvedValue({ data: { id: 's1' } });
      await callTool(server, 'plansync_plan_suggest', {
        projectId: 'p1',
        planId: 'pl1',
        field: 'goal',
        action: 'set',
        value: 'new goal',
        reason: 'better',
      });
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringContaining('/suggestions'),
        expect.objectContaining({ field: 'goal', action: 'set' }),
      );
    });

    it('M24: plansync_comment_create → POST comments', async () => {
      mockPost.mockResolvedValue({ data: { id: 'c1' } });
      await callTool(server, 'plansync_comment_create', {
        projectId: 'p1',
        planId: 'pl1',
        content: 'Hello',
      });
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringContaining('/comments'),
        expect.objectContaining({ content: 'Hello' }),
      );
    });
  });

  describe('M27-M34: Task + Execution tools', () => {
    let server: McpServer;
    beforeEach(() => {
      server = makeServer();
      api = new ApiClient(config);
      registerTaskTools(server, api);
    });

    it('M27: plansync_task_list → GET /tasks', async () => {
      mockGet.mockResolvedValue({ data: [] });
      await callTool(server, 'plansync_task_list', { projectId: 'p1' });
      expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('/tasks'));
    });

    it('M29: plansync_task_create → POST /tasks', async () => {
      mockPost.mockResolvedValue({ data: { id: 't1' } });
      await callTool(server, 'plansync_task_create', {
        projectId: 'p1',
        title: 'Task 1',
        type: 'code',
      });
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringContaining('/tasks'),
        expect.objectContaining({ title: 'Task 1' }),
      );
    });

    it('M31: plansync_task_claim → POST /claim with assigneeType=agent', async () => {
      mockPost.mockResolvedValue({ data: { id: 't1' } });
      await callTool(server, 'plansync_task_claim', { projectId: 'p1', taskId: 't1' });
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringContaining('/claim'),
        expect.objectContaining({ assigneeType: 'agent' }),
      );
    });
  });

  describe('M35-M39: Status + Drift tools', () => {
    let server: McpServer;
    beforeEach(() => {
      server = makeServer();
      api = new ApiClient(config);
      registerDriftTools(server, api);
      registerStatusTools(server, api);
    });

    it('M35: plansync_status → calls multiple GET requests for project/drifts/activities', async () => {
      mockGet.mockResolvedValue({ data: {} });
      await callTool(server, 'plansync_status', { projectId: 'p1' });
      expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('/api/projects/p1'));
    });

    it('M38: plansync_drift_list → GET /drifts', async () => {
      mockGet.mockResolvedValue({ data: [] });
      await callTool(server, 'plansync_drift_list', { projectId: 'p1' });
      expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('/drifts'));
    });

    it('M39: plansync_drift_resolve → POST drift action', async () => {
      mockPost.mockResolvedValue({ data: { status: 'resolved' } });
      await callTool(server, 'plansync_drift_resolve', {
        projectId: 'p1',
        driftId: 'd1',
        action: 'no_impact',
      });
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringContaining('/drifts/d1'),
        expect.objectContaining({ action: 'no_impact' }),
      );
    });
  });
});

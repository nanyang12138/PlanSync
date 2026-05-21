// R-016: In delegation mode, task write tools must issue requests as the agent
// (via api.withUser), not the original session user. Without this, claims and
// updates land on the owner instead of the delegated agent.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// vi.mock factories are hoisted above all imports, so declare mock state via
// vi.hoisted() so the mock factories can reference it safely.
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
  rootPatch,
  rootDelete,
  delegatedGet,
  delegatedPost,
  delegatedPatch,
  delegatedDelete,
  withUser,
  getDelegationAgent: getDelegationAgentMock,
} = mocks;

import { ApiClient } from '../src/api-client';
import { registerTaskTools } from '../src/tools/task';

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

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  const handler = getToolHandler(server, name);
  if (!handler) throw new Error(`Tool not found: ${name}`);
  return handler(args);
}

describe('R-016: task tools honour delegation agent', () => {
  let server: McpServer;
  let api: ApiClient;

  beforeEach(() => {
    rootGet.mockReset();
    rootPost.mockReset();
    rootPatch.mockReset();
    rootDelete.mockReset();
    delegatedGet.mockReset();
    delegatedPost.mockReset();
    delegatedPatch.mockReset();
    delegatedDelete.mockReset();
    withUser.mockClear();
    getDelegationAgentMock.mockReset();
    getDelegationAgentMock.mockReturnValue(undefined);

    server = makeServer();
    api = new ApiClient({
      apiBaseUrl: 'http://localhost:3001',
      apiToken: 'test',
      userName: 'owner',
    });
    registerTaskTools(server, api);
  });

  describe('without delegation', () => {
    it('task_claim uses the root api (no withUser call)', async () => {
      rootPost.mockResolvedValue({ data: {} });
      rootGet.mockResolvedValue({ data: { status: 'in_progress' } });

      await callTool(server, 'plansync_task_claim', { projectId: 'p1', taskId: 't1' });

      expect(withUser).not.toHaveBeenCalled();
      expect(rootPost).toHaveBeenCalledWith(
        expect.stringContaining('/claim'),
        expect.objectContaining({ assigneeType: 'agent' }),
      );
      expect(delegatedPost).not.toHaveBeenCalled();
    });

    it('task_update uses the root api (no withUser call)', async () => {
      rootPatch.mockResolvedValue({ data: {} });

      await callTool(server, 'plansync_task_update', {
        projectId: 'p1',
        taskId: 't1',
        status: 'in_progress',
      });

      expect(withUser).not.toHaveBeenCalled();
      expect(rootPatch).toHaveBeenCalled();
      expect(delegatedPatch).not.toHaveBeenCalled();
    });

    it('task_decline uses the root api (no withUser call)', async () => {
      rootPost.mockResolvedValue({ data: {} });
      rootGet.mockResolvedValue({ data: { assignee: null } });

      await callTool(server, 'plansync_task_decline', { projectId: 'p1', taskId: 't1' });

      expect(withUser).not.toHaveBeenCalled();
      expect(rootPost).toHaveBeenCalledWith(expect.stringContaining('/decline'), {});
      expect(delegatedPost).not.toHaveBeenCalled();
    });
  });

  describe('with delegation agent = "genie"', () => {
    beforeEach(() => {
      getDelegationAgentMock.mockReturnValue('genie');
    });

    it('task_claim issues both POST and verify GET as the delegated agent', async () => {
      delegatedPost.mockResolvedValue({ data: {} });
      delegatedGet.mockResolvedValue({ data: { status: 'in_progress' } });

      await callTool(server, 'plansync_task_claim', { projectId: 'p1', taskId: 't1' });

      expect(withUser).toHaveBeenCalledWith('genie');
      expect(delegatedPost).toHaveBeenCalledWith(
        expect.stringContaining('/claim'),
        expect.objectContaining({ assigneeType: 'agent' }),
      );
      expect(delegatedGet).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects/p1/tasks/t1'),
      );
      expect(rootPost).not.toHaveBeenCalled();
      expect(rootGet).not.toHaveBeenCalled();
    });

    it('task_update PATCH is sent as the delegated agent', async () => {
      delegatedPatch.mockResolvedValue({ data: {} });

      await callTool(server, 'plansync_task_update', {
        projectId: 'p1',
        taskId: 't1',
        status: 'in_progress',
      });

      expect(withUser).toHaveBeenCalledWith('genie');
      expect(delegatedPatch).toHaveBeenCalledWith(
        '/api/projects/p1/tasks/t1',
        expect.objectContaining({ status: 'in_progress' }),
      );
      expect(rootPatch).not.toHaveBeenCalled();
    });

    it('task_decline POST and verify GET are sent as the delegated agent', async () => {
      delegatedPost.mockResolvedValue({ data: {} });
      delegatedGet.mockResolvedValue({ data: { assignee: null } });

      await callTool(server, 'plansync_task_decline', { projectId: 'p1', taskId: 't1' });

      expect(withUser).toHaveBeenCalledWith('genie');
      expect(delegatedPost).toHaveBeenCalledWith(expect.stringContaining('/decline'), {});
      expect(delegatedGet).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects/p1/tasks/t1'),
      );
      expect(rootPost).not.toHaveBeenCalled();
    });

    it('task_create POST is sent as the delegated agent', async () => {
      delegatedPost.mockResolvedValue({ data: { id: 't1' } });

      await callTool(server, 'plansync_task_create', {
        projectId: 'p1',
        title: 'Task 1',
        type: 'code',
      });

      expect(withUser).toHaveBeenCalledWith('genie');
      expect(delegatedPost).toHaveBeenCalledWith(
        '/api/projects/p1/tasks',
        expect.objectContaining({ title: 'Task 1' }),
      );
      expect(rootPost).not.toHaveBeenCalled();
    });
  });
});

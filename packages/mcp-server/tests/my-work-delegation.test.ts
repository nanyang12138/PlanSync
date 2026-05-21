// R-018: When the my_work MCP tool is invoked cross-project with agentName,
// it must forward `?user=<agentName>` to the API so the API returns work for
// the agent (not the caller). Without this query param the cross-project
// branch silently ignores agentName.
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

const { rootGet } = mocks;

import { ApiClient } from '../src/api-client';
import { registerStatusTools } from '../src/tools/status';

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

describe('R-018: my_work cross-project forwards agentName as ?user=', () => {
  let server: McpServer;
  let api: ApiClient;

  beforeEach(() => {
    rootGet.mockReset();
    server = makeServer();
    api = new ApiClient({
      apiBaseUrl: 'http://localhost:3001',
      apiToken: 'test',
      userName: 'owner',
    });
    registerStatusTools(server, api, {
      apiBaseUrl: 'http://localhost:3001',
      apiToken: 'test',
      userName: 'owner',
    });
  });

  it('passes ?user=<agentName> to /api/my-work when called cross-project with agentName', async () => {
    rootGet.mockResolvedValue({ reviews: [], drifts: [], tasks: [] });

    await callTool(server, 'plansync_my_work', { agentName: 'genie' });

    expect(rootGet).toHaveBeenCalledTimes(1);
    expect(rootGet).toHaveBeenCalledWith('/api/my-work?user=genie');
  });

  it('omits the ?user= query when no agentName is provided', async () => {
    rootGet.mockResolvedValue({ reviews: [], drifts: [], tasks: [] });

    await callTool(server, 'plansync_my_work', {});

    expect(rootGet).toHaveBeenCalledTimes(1);
    expect(rootGet).toHaveBeenCalledWith('/api/my-work');
  });

  it('url-encodes the agentName when it contains reserved characters', async () => {
    rootGet.mockResolvedValue({ reviews: [], drifts: [], tasks: [] });

    await callTool(server, 'plansync_my_work', { agentName: 'agent with space&plus' });

    expect(rootGet).toHaveBeenCalledWith('/api/my-work?user=agent%20with%20space%26plus');
  });
});

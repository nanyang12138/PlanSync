// R-027 / R-028: MCP `plansync_task_update` and `plansync_task_create` must
// reuse @plansync/shared input schemas so the MCP tool contract cannot silently
// drift from the API contract. This test pins both tools' input field sets to
// the corresponding shared shape plus the URL routing fields.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTaskShape, updateTaskShape } from '@plansync/shared';

vi.mock('../src/api-client', () => ({
  ApiClient: vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    withUser: vi.fn(),
  })),
}));

vi.mock('../src/tools/status', () => ({
  getDelegationAgent: vi.fn(() => undefined),
  registerStatusTools: vi.fn(),
}));

import { ApiClient } from '../src/api-client';
import { registerTaskTools } from '../src/tools/task';

function getInputShapeKeys(server: McpServer, name: string): string[] {
  const tools = (server as unknown as { _registeredTools: Record<string, { inputSchema?: { shape: Record<string, unknown> } }> })
    ._registeredTools;
  const tool = tools[name];
  if (!tool || !tool.inputSchema) {
    throw new Error(`Tool ${name} not registered or has no inputSchema`);
  }
  return Object.keys(tool.inputSchema.shape).sort();
}

describe('R-027/R-028: MCP task tool schemas reuse @plansync/shared', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.0.1' });
    const api = new ApiClient({
      apiBaseUrl: 'http://localhost:3001',
      apiToken: 'test',
      userName: 'tester',
    });
    registerTaskTools(server, api);
  });

  it('plansync_task_update exposes exactly the shared updateTaskShape fields plus projectId/taskId', () => {
    const expected = [...Object.keys(updateTaskShape), 'projectId', 'taskId'].sort();
    const actual = getInputShapeKeys(server, 'plansync_task_update');
    expect(actual).toEqual(expected);
  });

  it('plansync_task_update accepts every field that the shared schema accepts', () => {
    // Concretely verify the fields the original MCP tool was MISSING (the
    // bug R-027 closes): type, branchName, prUrl, agentContext,
    // expectedOutput, agentConstraints, startDate, dueDate.
    const required = [
      'type',
      'branchName',
      'prUrl',
      'agentContext',
      'expectedOutput',
      'agentConstraints',
      'startDate',
      'dueDate',
    ];
    const actual = getInputShapeKeys(server, 'plansync_task_update');
    for (const field of required) {
      expect(actual).toContain(field);
    }
  });

  it('plansync_task_create exposes exactly the shared createTaskShape fields plus projectId', () => {
    const expected = [...Object.keys(createTaskShape), 'projectId'].sort();
    const actual = getInputShapeKeys(server, 'plansync_task_create');
    expect(actual).toEqual(expected);
  });

  it('plansync_task_create accepts the new "test" task type (added in shared)', () => {
    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }
        >;
      }
    )._registeredTools;
    const result = tools['plansync_task_create'].inputSchema.safeParse({
      projectId: 'p1',
      title: 'A test task',
      type: 'test',
    });
    expect(result.success).toBe(true);
  });
});

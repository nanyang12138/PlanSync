// R-034: Schema-drift CI guard.
//
// MCP tool input schemas that mirror an `@plansync/shared` shape MUST stay in
// lockstep with that shape. When a developer adds a field to the shared schema
// (and therefore to the API contract) but forgets to surface it through MCP,
// agents lose the ability to set that field — silently. The previous
// R-027/R-028 fix made `plansync_task_create` / `plansync_task_update` reuse
// `createTaskShape` / `updateTaskShape` by spreading them, but that pattern is
// only protective if a test pins it. Without this guard, a future refactor
// could replace the spread with hand-rolled keys and re-introduce the drift.
//
// This test enumerates every MCP tool whose input shape is supposed to mirror
// a shared shape, plus a small whitelist of MCP-only "routing" fields
// (`projectId`, `taskId`, …) that exist because MCP tool inputs flatten the
// REST URL parameters into the body. Any divergence (missing or extra field)
// fails the test, forcing the author to either update the mapping table here
// or fix the MCP tool.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createTaskShape,
  updateTaskShape,
  createProjectSchema,
  updateProjectSchema,
} from '@plansync/shared';

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
import { registerProjectTools } from '../src/tools/project';

type Shape = Record<string, unknown>;

function getInputShapeKeys(server: McpServer, name: string): string[] {
  const tools = (
    server as unknown as {
      _registeredTools: Record<string, { inputSchema?: { shape: Shape } }>;
    }
  )._registeredTools;
  const tool = tools[name];
  if (!tool || !tool.inputSchema) {
    throw new Error(`Tool ${name} not registered or has no inputSchema`);
  }
  return Object.keys(tool.inputSchema.shape).sort();
}

interface DriftMapping {
  toolName: string;
  sharedShape: Shape;
  // Extra fields the MCP tool legitimately adds on top of the shared shape
  // (typically URL routing parameters that the REST API takes from the path).
  // Anything in the MCP tool's input that is not in `sharedShape` MUST appear
  // here, otherwise the test treats it as drift.
  allowedExtras: readonly string[];
}

describe('R-034: MCP tool input schemas stay in lockstep with @plansync/shared', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.0.1' });
    const api = new ApiClient({
      apiBaseUrl: 'http://localhost:3001',
      apiToken: 'test',
      userName: 'tester',
    });
    registerTaskTools(server, api);
    registerProjectTools(server, api);
  });

  const mappings: DriftMapping[] = [
    {
      toolName: 'plansync_task_create',
      sharedShape: createTaskShape as unknown as Shape,
      allowedExtras: ['projectId'],
    },
    {
      toolName: 'plansync_task_update',
      sharedShape: updateTaskShape as unknown as Shape,
      allowedExtras: ['projectId', 'taskId'],
    },
    {
      toolName: 'plansync_project_create',
      sharedShape: createProjectSchema.shape as unknown as Shape,
      allowedExtras: [],
    },
    {
      toolName: 'plansync_project_update',
      sharedShape: updateProjectSchema.shape as unknown as Shape,
      allowedExtras: ['projectId'],
    },
  ];

  for (const mapping of mappings) {
    it(`${mapping.toolName} input shape = shared keys + allowed extras`, () => {
      const expected = [...Object.keys(mapping.sharedShape), ...mapping.allowedExtras].sort();
      const actual = getInputShapeKeys(server, mapping.toolName);

      // The two key-set comparisons below give precise failure messages:
      //   - missing  : field exists in shared (or extras) but not in MCP
      //   - unexpected: field exists in MCP but is neither in shared nor in
      //                 the explicit allowlist — i.e. silent MCP-only drift.
      const expectedSet = new Set(expected);
      const actualSet = new Set(actual);
      const missing = expected.filter((k) => !actualSet.has(k));
      const unexpected = actual.filter((k) => !expectedSet.has(k));

      expect(
        missing,
        `${mapping.toolName} is missing keys from shared schema: ${missing.join(', ')}`,
      ).toEqual([]);
      expect(
        unexpected,
        `${mapping.toolName} has MCP-only keys not in the allowlist: ${unexpected.join(', ')}. ` +
          `If these are intentional, add them to allowedExtras in schema-drift.test.ts.`,
      ).toEqual([]);
      expect(actual).toEqual(expected);
    });
  }

  it('covers every MCP tool that imports a shape from @plansync/shared', () => {
    // Hard-coded list of tool names that the mapping table above must cover.
    // If a new MCP tool starts spreading a shared schema shape into its input,
    // it MUST be added here AND to the `mappings` table — otherwise this guard
    // is silently bypassed for the new tool. The list is intentionally small
    // and explicit so reviewers see it grow when contracts widen.
    const expectedCovered = [
      'plansync_task_create',
      'plansync_task_update',
      'plansync_project_create',
      'plansync_project_update',
    ].sort();
    const covered = mappings.map((m) => m.toolName).sort();
    expect(covered).toEqual(expectedCovered);
  });
});

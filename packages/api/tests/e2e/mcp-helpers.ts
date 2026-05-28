// Shared helpers for E2E tests that use the MCP server directly.
//
// connectMcpClient() uses `plansync --host cursor` (writes .cursor/mcp.json and exits
// cleanly, no genie exec) to discover the MCP server config, then spawns a
// StdioClientTransport connected to the MCP server process.
//
// runGenie() launches `genie -p` with:
//   --dangerously-skip-permissions  auto-approves all tool calls (no stdin blocking)
//   --mcp-config JSON               passes MCP server config directly (no settings.json)
// This avoids settings.json manipulation and prevents genie from blocking on permission
// prompts when stdin is already consumed by the prompt text.
// MCP SDK 1.29+ exposes `./client` (no `index.js` suffix) as the canonical
// subpath in package `exports`. The wildcard `./*` mapping further down the
// exports object would also accept the historic `./client/index.js` path,
// but TypeScript's `bundler` moduleResolution does not follow that wildcard
// for type lookup, so we use the canonical subpath here.
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const LOCAL_NODE_REPO = path.join(ROOT, '.local-runtime/node/bin/node');
/**
 * Resolve the Node binary used to spawn the MCP server / CLI from the e2e
 * tests. The repo-local runtime ({@link LOCAL_NODE_REPO}) is preferred so
 * dev workstations stay reproducible, but environments that do not run
 * `bin/ps-admin start` (most prominently the GitHub Actions nightly job,
 * which uses `actions/setup-node@v4` and never bootstraps the local
 * runtime) must fall back to whatever Node is on the PATH — i.e. the same
 * Node interpreter currently running this test process.
 *
 * The fallback used to be unconditional, which surfaced as
 *   `Local node runtime not found at .../.local-runtime/node/bin/node`
 * in #143 — every e2e test that shells out via `runGenie`/`cli` exited 127.
 */
const LOCAL_NODE = fs.existsSync(LOCAL_NODE_REPO) ? LOCAL_NODE_REPO : process.execPath;
const CLI_BUNDLE = path.join(ROOT, 'packages/cli/dist/index.js');
const MCP_SERVER = path.join(ROOT, 'packages/mcp-server/dist/index.js');
const GENIE = process.env.GENIE_BIN || '/proj/verif_release_ro/genie/current/bin/genie';

/**
 * Spin up a real MCP client connected to the PlanSync MCP server.
 * Constructs the StdioClientTransport directly from known constants rather than
 * shelling out to `bin/plansync --host cursor`, which calls _ensure_credentials()
 * and dies in non-TTY CI environments when PLANSYNC_API_KEY is absent. The MCP
 * server authenticates via PLANSYNC_SECRET (the master secret), not per-user
 * passwords, so no credential check is needed here.
 */
export async function connectMcpClient(serverUrl: string, user: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: LOCAL_NODE,
    args: [MCP_SERVER],
    env: {
      ...process.env,
      PLANSYNC_API_URL: serverUrl,
      PLANSYNC_USER: user,
      PLANSYNC_SECRET: process.env.PLANSYNC_SECRET || 'dev-secret',
      PLANSYNC_PROJECT: '',
      LOG_LEVEL: process.env.LOG_LEVEL || 'warn',
    },
  });
  const client = new Client({ name: 'e2e-test', version: '0.0.1' });
  await client.connect(transport);
  return client;
}

/**
 * Run genie -p with a prompt and plansync MCP server configured via --mcp-config.
 *
 * Key flags used:
 *   --dangerously-skip-permissions  Auto-approve all tool calls without prompting.
 *                                   Without this, genie blocks waiting for a permission
 *                                   response on stdin that is already closed (consumed
 *                                   by the prompt text), causing infinite hang.
 *   --mcp-config JSON               Pass MCP server config directly, bypassing
 *                                   ~/.claude/settings.json entirely.
 */
export function runGenie(
  prompt: string,
  serverUrl: string,
  user: string,
  workDir: string,
  timeoutMs: number = 600_000,
): { status: number | null; stdout: string; stderr: string } {
  const secret = process.env.PLANSYNC_SECRET || 'dev-secret';
  const mcpConfig = JSON.stringify({
    mcpServers: {
      plansync: {
        command: LOCAL_NODE,
        args: [MCP_SERVER],
        env: {
          PLANSYNC_API_URL: serverUrl,
          PLANSYNC_SECRET: secret,
          PLANSYNC_USER: user,
          PLANSYNC_PROJECT: '',
          LOG_LEVEL: 'warn',
        },
      },
    },
  });

  const result = spawnSync(
    'bash',
    [GENIE, '-p', '--dangerously-skip-permissions', '--mcp-config', mcpConfig],
    {
      input: prompt,
      encoding: 'utf8',
      timeout: timeoutMs,
      cwd: workDir,
      env: {
        ...process.env,
        PLANSYNC_API_URL: serverUrl,
        PLANSYNC_SECRET: secret,
        PLANSYNC_USER: user,
      },
    },
  ) as { status: number | null; stdout: string; stderr: string };

  if (result.status === null) {
    // Process was killed (timeout). Log partial output for debugging.
    console.error(
      `[runGenie] TIMEOUT after ${timeoutMs}ms. Partial stdout:\n${result.stdout?.slice(-2000)}\nPartial stderr:\n${result.stderr?.slice(-1000)}`,
    );
  } else if (result.status !== 0) {
    console.error(
      `[runGenie] Exit ${result.status}. stdout:\n${result.stdout?.slice(-2000)}\nstderr:\n${result.stderr?.slice(-1000)}`,
    );
  }

  return result;
}

/**
 * Call an MCP tool and parse the JSON response.
 * MCP server returns: { content: [{ type: 'text', text: JSON.stringify(apiResponse) }] }
 */
export async function mcp(
  client: Client,
  tool: string,
  args: Record<string, unknown>,
): Promise<any> {
  const result = await client.callTool({ name: tool, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content[0]?.text ?? '';
  return JSON.parse(text);
}

/**
 * Run the plansync-cli (packages/cli/dist/index.js) via the local Node runtime.
 * This is the "human CLI user" perspective for verification.
 */
export function cli(
  args: string[],
  projectId: string,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const API_SECRET = process.env.PLANSYNC_SECRET || 'dev-secret';
  return spawnSync(LOCAL_NODE, [CLI_BUNDLE, ...args], {
    timeout: 15_000,
    encoding: 'utf8',
    env: {
      ...process.env,
      PLANSYNC_API_URL: process.env.PLANSYNC_API_URL || 'http://localhost:3001',
      PLANSYNC_PROJECT: projectId,
      PLANSYNC_SECRET: API_SECRET,
      ...extraEnv,
    },
  }) as { status: number | null; stdout: string; stderr: string };
}

/**
 * Delete a project via the admin REST API (MCP does not expose DELETE project).
 */
export async function deleteProject(serverUrl: string, projectId: string): Promise<void> {
  if (!projectId) return;
  await fetch(`${serverUrl}/api/projects/${projectId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${process.env.PLANSYNC_SECRET || 'dev-secret'}`,
      'X-User-Name': 'e2e-cleanup',
    },
  }).catch(() => {});
}

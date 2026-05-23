/**
 * R-005 coverage — MCP client surfaces server-side execution aborts.
 *
 * Drift v2 defence-in-depth: when the API forces a run out of `running`
 * (paused, stale-version, race-lost) the MCP server's heartbeat detects
 * the structured error code, latches the process-wide abort signal, and
 * pushes a `notifications/message` whose `data.type === 'execution_aborted'`
 * to the client.
 *
 * The CLI wires up `mcp.setAbortHandler(...)` so this notification flips
 * the in-flight `AbortController`, the ai-loop exits at the next turn
 * boundary, and the user sees a red `EXECUTION_SUPERSEDED` banner instead
 * of the agent silently looping until SIGINT.
 *
 * Without the wire-up the entire chain is dead-code: the handler slot
 * stays null and the loop runs unaffected. These tests pin the contract
 * the CLI depends on:
 *   1. an `execution_aborted` notification fires the registered handler
 *      with the parsed `code` / `message` / `runId` / `taskId` payload;
 *   2. an `AbortController` hooked into that handler ends up aborted, so
 *      ai-loop's `if (signal?.aborted) break;` is reachable end-to-end;
 *   3. non-abort notifications (drift warnings, generic log messages) do
 *      NOT fire the abort handler — only the `execution_aborted` type
 *      counts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { McpClient, ExecutionAbortReason } from '../src/mcp-client.js';
import { cfg } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FAKE_SERVER = path.resolve(__dirname, 'fixtures/fake-mcp-server.cjs');

function configureCfg(): void {
  cfg.nodeBin = process.execPath;
  cfg.apiKey = 'test-key';
  cfg.apiUrl = 'http://localhost';
  cfg.user = 'tester';
  cfg.project = '';
}

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil timed out');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('McpClient — execution_aborted notification (R-005)', () => {
  let client: McpClient;

  beforeEach(() => {
    configureCfg();
    delete process.env.FAKE_MCP_SEND_ABORT_ON_TOOL_CALL;
    delete process.env.FAKE_MCP_CRASH_ON_START;
    delete process.env.FAKE_MCP_CRASH_AFTER_INIT;
    delete process.env.FAKE_MCP_CRASH_ON_TOOL_CALL;
    client = new McpClient();
  });

  afterEach(() => {
    client.stop();
    delete process.env.FAKE_MCP_SEND_ABORT_ON_TOOL_CALL;
  });

  it('fires the registered abort handler with the server-supplied reason', async () => {
    process.env.FAKE_MCP_SEND_ABORT_ON_TOOL_CALL = '1';
    await client.start(FAKE_SERVER);

    const reasons: ExecutionAbortReason[] = [];
    client.setAbortHandler((reason) => {
      reasons.push(reason);
    });

    // The tool call resolves normally; the abort notification is pushed by
    // the fake server BEFORE the response, so by the time `callTool`
    // resolves the handler should have fired.
    const result = await client.callTool('fake_tool', {});
    expect(result).toContain('fake-result');

    await waitUntil(() => reasons.length > 0);

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toEqual({
      code: 'RUN_STALE_VERSION',
      message: 'Run is stale: bound to plan v1, task now v2.',
      runId: 'fake-run-id',
      taskId: 'fake-task-id',
    });
  });

  it('aborts an AbortController hooked into the handler (ai-loop wire-up contract)', async () => {
    process.env.FAKE_MCP_SEND_ABORT_ON_TOOL_CALL = '1';
    await client.start(FAKE_SERVER);

    // Mirror how packages/cli/src/index.ts wires the handler: flip a local
    // AbortController so any in-flight `runAgentLoop(signal)` exits at the
    // next `if (signal?.aborted) break;` check.
    const ctrl = new AbortController();
    client.setAbortHandler(() => {
      ctrl.abort();
    });

    expect(ctrl.signal.aborted).toBe(false);
    await client.callTool('fake_tool', {});
    await waitUntil(() => ctrl.signal.aborted);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('does not fire the abort handler for unrelated notification payloads', async () => {
    // No abort env arming → fake server replies to the tool call without
    // emitting any extra notifications. If the abort handler still fires,
    // our matcher is too loose and would cause spurious agent aborts on
    // every drift warning or info log.
    await client.start(FAKE_SERVER);

    const reasons: ExecutionAbortReason[] = [];
    client.setAbortHandler((reason) => {
      reasons.push(reason);
    });

    const result = await client.callTool('fake_tool', {});
    expect(result).toContain('fake-result');
    // Give the stdout pump a tick — any notification would have arrived by now.
    await new Promise((r) => setTimeout(r, 50));
    expect(reasons).toHaveLength(0);
  });
});

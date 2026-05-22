/**
 * R-021 coverage — MCP client crash detection and auto-recovery.
 *
 * Real-process integration tests: each case spawns the small fake MCP
 * server in tests/fixtures/ via the production code path (no mocks at
 * the subprocess boundary). This ensures the `exit` handler, pending
 * map cleanup, crash counter, and `ensureRunning` retry loop all behave
 * correctly end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { McpClient } from '../src/mcp-client.js';
import { cfg } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FAKE_SERVER = path.resolve(__dirname, 'fixtures/fake-mcp-server.cjs');
const MISSING_SERVER = path.resolve(__dirname, 'fixtures/does-not-exist.cjs');

function configureCfg(): void {
  cfg.nodeBin = process.execPath;
  cfg.apiKey = 'test-key';
  cfg.apiUrl = 'http://localhost';
  cfg.user = 'tester';
  cfg.project = '';
}

async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('McpClient — crash detection and auto-recovery (R-021)', () => {
  let client: McpClient;

  beforeEach(() => {
    configureCfg();
    delete process.env.FAKE_MCP_CRASH_ON_START;
    delete process.env.FAKE_MCP_CRASH_AFTER_INIT;
    delete process.env.FAKE_MCP_CRASH_AFTER_MS;
    delete process.env.FAKE_MCP_CRASH_AFTER_REQUESTS;
    delete process.env.FAKE_MCP_CRASH_ON_TOOL_CALL;
    client = new McpClient();
    // Avoid real exponential-backoff sleeps slowing the suite down.
    client._setSleepFnForTests(async () => {});
  });

  afterEach(() => {
    client.stop();
  });

  it('marks isRunning() false and isHealthy() true after a graceful stop', async () => {
    await client.start(FAKE_SERVER);
    expect(client.isRunning()).toBe(true);
    expect(client.isHealthy()).toBe(true);

    client.stop();
    expect(client.isRunning()).toBe(false);
    // Graceful shutdown must not bump the crash counter.
    expect(client._getConsecutiveCrashesForTests()).toBe(0);
    expect(client.isHealthy()).toBe(true);
  });

  it('detects an unexpected subprocess exit and rejects pending requests with MCP_CRASHED', async () => {
    // The fake server inherits env at spawn time. Arming the flag here
    // ensures the *next* tools/call crashes the subprocess before it
    // sends a reply, so the in-flight call must be rejected by McpClient's
    // exit handler (not by the per-request 30 s timeout).
    process.env.FAKE_MCP_CRASH_ON_TOOL_CALL = '1';
    await client.start(FAKE_SERVER);
    expect(client.isRunning()).toBe(true);

    const inflight = client.callTool('fake_tool', {});

    await expect(inflight).rejects.toThrow(/MCP_CRASHED/);
    expect(client.isRunning()).toBe(false);
    expect(client._getConsecutiveCrashesForTests()).toBeGreaterThanOrEqual(1);
  });

  it('ensureRunning restarts after a crash and the next callTool succeeds', async () => {
    process.env.FAKE_MCP_CRASH_AFTER_INIT = '1';
    await client.start(FAKE_SERVER).catch(() => {
      // Some scheduling orders cause the crash to land before tools/list
      // resolves; either way the client should end up not-running.
    });
    // The crash-after-init branch may race with the tools/list reply;
    // wait for the exit listener to definitely have fired.
    for (let i = 0; i < 50 && client.isRunning(); i += 1) {
      await wait(10);
    }
    expect(client.isRunning()).toBe(false);
    expect(client._getConsecutiveCrashesForTests()).toBeGreaterThanOrEqual(1);

    // Clear the crash flag so the restart attempt yields a healthy server.
    delete process.env.FAKE_MCP_CRASH_AFTER_INIT;

    const ok = await client.ensureRunning(FAKE_SERVER);
    expect(ok).toBe(true);
    expect(client.isRunning()).toBe(true);
    // A successful start resets the streak.
    expect(client._getConsecutiveCrashesForTests()).toBe(0);
    expect(client.isHealthy()).toBe(true);

    const result = await client.callTool('fake_tool', {});
    expect(result).toContain('fake-result');
  });

  it('reports unhealthy after 3 consecutive failed restart attempts', async () => {
    // Three back-to-back spawn failures: the missing path causes spawn to
    // dispatch an `error` event and the subprocess never produces stdout,
    // so `start()` rejects via the internal request timeout. We override
    // sleepFn (in beforeEach) so the backoff is instant.
    //
    // We loop ensureRunning three times to simulate three crashes that
    // could not be recovered from. Each call returns false; after the
    // third the crash counter must be >= MAX_CONSECUTIVE_CRASHES (3).
    //
    // Note: each `ensureRunning` call internally retries up to 3 times,
    // so a single call is already enough to push the counter past the
    // threshold. We assert the documented invariant: 3+ crashes → unhealthy.
    process.env.FAKE_MCP_CRASH_ON_START = '1';

    for (let i = 0; i < 3; i += 1) {
      const ok = await client.ensureRunning(FAKE_SERVER);
      expect(ok).toBe(false);
    }

    expect(client._getConsecutiveCrashesForTests()).toBeGreaterThanOrEqual(3);
    expect(client.isHealthy()).toBe(false);
  }, 20000);

  it('ensureRunning returns false when the server path does not exist', async () => {
    const ok = await client.ensureRunning(MISSING_SERVER);
    expect(ok).toBe(false);
    expect(client.isRunning()).toBe(false);
  }, 20000);
});

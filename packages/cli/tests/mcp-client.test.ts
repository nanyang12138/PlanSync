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
import fs from 'fs';
import os from 'os';
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
    delete process.env.FAKE_MCP_CRASH_ON_TOOL_CALL_ONCE_FILE;
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

describe('McpClient — callTool single retry on transport error (R-022)', () => {
  let client: McpClient;
  let markerFile: string | null = null;

  beforeEach(() => {
    configureCfg();
    delete process.env.FAKE_MCP_CRASH_ON_START;
    delete process.env.FAKE_MCP_CRASH_AFTER_INIT;
    delete process.env.FAKE_MCP_CRASH_AFTER_MS;
    delete process.env.FAKE_MCP_CRASH_AFTER_REQUESTS;
    delete process.env.FAKE_MCP_CRASH_ON_TOOL_CALL;
    delete process.env.FAKE_MCP_CRASH_ON_TOOL_CALL_ONCE_FILE;
    client = new McpClient();
    client._setSleepFnForTests(async () => {});
  });

  afterEach(() => {
    client.stop();
    if (markerFile) {
      try {
        fs.unlinkSync(markerFile);
      } catch {
        /* file may already be gone */
      }
      markerFile = null;
    }
    delete process.env.FAKE_MCP_CRASH_ON_TOOL_CALL_ONCE_FILE;
  });

  it('callTool transparently restarts when the first send finds the subprocess dead', async () => {
    // Verification per R-022: "first stdin write fails, second succeeds → tool
    // call returns success". Here we simulate the failure mode by killing the
    // subprocess from outside (so isRunning() flips to false before the call
    // is dispatched). The retry path inside callTool should call ensureRunning,
    // spawn a fresh subprocess, and return the tool result without surfacing
    // the transport error to the caller.
    await client.start(FAKE_SERVER);
    expect(client.isRunning()).toBe(true);

    // Reach into the underlying handle the same way `stop()` does, but skip
    // setting `intentionalShutdown` so the exit handler treats it as a crash —
    // this exercises the same code path a real MCP subprocess crash would.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = (client as any).proc as { kill: () => void } | null;
    expect(proc).not.toBeNull();
    proc!.kill();

    // Wait for the exit handler to flip isRunning() to false.
    for (let i = 0; i < 50 && client.isRunning(); i += 1) {
      await wait(10);
    }
    expect(client.isRunning()).toBe(false);
    const crashesBefore = client._getConsecutiveCrashesForTests();
    expect(crashesBefore).toBeGreaterThanOrEqual(1);

    // The first send would fail because proc is null; callTool must
    // ensureRunning() and produce a real tool result instead of throwing.
    const result = await client.callTool('fake_tool', {});
    expect(result).toContain('fake-result');
    expect(client.isRunning()).toBe(true);
  });

  it('callTool retries exactly once when the subprocess crashes mid-request, then succeeds', async () => {
    // Verification per R-022: cover the in-flight failure path. The fake
    // server arms a one-shot crash on its first tools/call (controlled by a
    // marker file we create here) and replies normally on the second spawn.
    // Internally:
    //   1. callTool sends tools/call → subprocess crashes mid-request.
    //   2. McpClient's exit handler rejects the pending request with
    //      MCP_CRASHED.
    //   3. callTool's catch sees it as a transport error, calls
    //      ensureRunning() to spawn a fresh subprocess.
    //   4. The fresh subprocess does NOT see the marker file (deleted) and
    //      replies normally → callTool returns the tool result.
    markerFile = path.join(os.tmpdir(), `plansync-r022-crash-${process.pid}-${Date.now()}`);
    fs.writeFileSync(markerFile, '1');
    process.env.FAKE_MCP_CRASH_ON_TOOL_CALL_ONCE_FILE = markerFile;

    await client.start(FAKE_SERVER);
    expect(client.isRunning()).toBe(true);

    const result = await client.callTool('fake_tool', {});
    expect(result).toContain('fake-result');
    expect(client.isRunning()).toBe(true);
    // Exactly one crash should have been recorded — the second spawn was
    // healthy and reset the counter as part of start()'s success path.
    expect(client._getConsecutiveCrashesForTests()).toBe(0);
  });

  it('stop() synchronously rejects pending requests with "MCP shutdown" (R-024)', async () => {
    // R-024 fix: previously `stop()` only killed the subprocess and the
    // async `exit` handler was responsible for rejecting pending requests.
    // Because `stop()` nulled `this.proc` first, the exit handler's
    // identity check (`this.proc !== proc`) skipped the cleanup branch and
    // pending Promises hung until their per-request 30 s timeout fired.
    //
    // The fix rejects every pending request synchronously inside `stop()`
    // and clears the map. This test inserts a sentinel entry into the
    // private `pending` map (the same map `callTool` populates) and
    // verifies that its rejection fires the moment `stop()` returns.
    await client.start(FAKE_SERVER);
    expect(client.isRunning()).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pendingMap = (client as any).pending as Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >;

    const inflight = new Promise<unknown>((resolve, reject) => {
      pendingMap.set(424242, { resolve, reject });
    });

    expect(pendingMap.size).toBeGreaterThanOrEqual(1);

    client.stop();

    // The pending map must be drained synchronously by stop().
    expect(pendingMap.size).toBe(0);

    // And the captured promise must reject with the documented message,
    // without waiting for the per-request 30 s timeout.
    await expect(inflight).rejects.toThrow(/MCP shutdown/);

    // Intentional shutdown — must not bump the crash counter even though
    // we rejected an "in-flight" entry.
    expect(client._getConsecutiveCrashesForTests()).toBe(0);
    expect(client.isHealthy()).toBe(true);
  });

  it('callTool surfaces JSON-RPC errors without retrying (no infinite loop on real failures)', async () => {
    // R-022 must NOT retry on non-transport errors — retrying a malformed
    // argument or a server-side rejection is never useful and can mask bugs.
    // The fake server returns a JSON-RPC error envelope for the "fake_error"
    // tool name, which McpClient surfaces as a plain Error (not MCP_CRASHED).
    // We assert that exactly one spawn happens (no auto-restart) by checking
    // the crash counter stays at 0 throughout.
    await client.start(FAKE_SERVER);
    expect(client.isRunning()).toBe(true);

    await expect(client.callTool('fake_error_tool', {})).rejects.toThrow(/fake-protocol-error/);
    // Subprocess is still healthy and has not been restarted.
    expect(client.isRunning()).toBe(true);
    expect(client._getConsecutiveCrashesForTests()).toBe(0);
  });
});

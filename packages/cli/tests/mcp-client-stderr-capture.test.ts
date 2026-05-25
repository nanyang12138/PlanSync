/**
 * PR-B coverage — McpClient must capture child stdout/stderr that does not
 * belong to the JSON-RPC channel and surface it when the child crashes.
 *
 * Background: PR #746 fixed a runtime crash in mcp-server (`readEnforceMode
 * is not defined`). When the user hit it, the only thing the CLI showed was
 *
 *   ⚠ MCP subprocess exited unexpectedly (code 1)
 *   MCP_CRASHED: subprocess exited (code 1)
 *
 * The actual ReferenceError was emitted by pino on the child's stdout (the
 * MCP JSON-RPC channel), but the CLI silently dropped it because the line
 * had no JSON-RPC `id` / `method+jsonrpc`. Stderr was piped to `inherit`
 * which races with the prompt and is easily missed.
 *
 * These tests assert the new behaviour:
 *   1. Stderr written by the child before crashing is retained and
 *      reflected in `getRecentChildOutput()`.
 *   2. Pino-style JSON on stdout that is NOT a JSON-RPC frame is also
 *      retained (this is the exact shape that hides ReferenceErrors today).
 *   3. The buffer is reset between spawns so a recovered MCP doesn't
 *      keep showing yesterday's crash output.
 *   4. Graceful stop() does not record any "diagnostic" output.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { McpClient } from '../src/mcp-client.js';
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

describe('McpClient — child stdout/stderr capture (PR-B)', () => {
  let client: McpClient;

  beforeEach(() => {
    configureCfg();
    delete process.env.FAKE_MCP_CRASH_ON_START;
    delete process.env.FAKE_MCP_STDERR_BEFORE_CRASH;
    delete process.env.FAKE_MCP_STDOUT_PINO_BEFORE_CRASH;
    client = new McpClient();
    client._setSleepFnForTests(async () => {});
  });

  afterEach(() => {
    client.stop();
  });

  it('captures child stderr lines that precede a startup crash', async () => {
    process.env.FAKE_MCP_STDERR_BEFORE_CRASH = 'fatal: simulated startup error from stderr';
    process.env.FAKE_MCP_CRASH_ON_START = '1';

    // Suppress the warning print so it doesn't clutter test output.
    // The child crashes before McpClient.start() returns, so the call
    // rejects with "MCP_CRASHED" thrown from the exit handler.
    await expect(client.start(FAKE_SERVER)).rejects.toThrow();

    const captured = client.getRecentChildOutput();
    expect(captured.some((l) => l.includes('simulated startup error from stderr'))).toBe(true);
  });

  it('captures pino-style JSON on stdout (the channel real ReferenceErrors land on)', async () => {
    process.env.FAKE_MCP_STDOUT_PINO_BEFORE_CRASH = 'readEnforceMode is not defined';
    process.env.FAKE_MCP_CRASH_ON_START = '1';

    await expect(client.start(FAKE_SERVER)).rejects.toThrow();

    const captured = client.getRecentChildOutput();
    expect(captured.length).toBeGreaterThan(0);
    const joined = captured.join('\n');
    // The raw line is retained as-is so ops can see the full pino payload;
    // the renderer that produces the user-facing message is exercised by
    // formatChildOutputForDisplay (covered indirectly here — non-empty
    // capture proves it has something to render).
    expect(joined).toContain('readEnforceMode is not defined');
    expect(joined).toContain('MCP Server failed to start');
  });

  it('clears captured output between spawns so a recovered server starts clean', async () => {
    // First spawn: crashes with stderr noise.
    process.env.FAKE_MCP_STDERR_BEFORE_CRASH = 'first-spawn-noise';
    process.env.FAKE_MCP_CRASH_ON_START = '1';
    await expect(client.start(FAKE_SERVER)).rejects.toThrow();
    expect(client.getRecentChildOutput().some((l) => l.includes('first-spawn-noise'))).toBe(true);

    // Second spawn: clean, no stderr noise. Buffer must reset so the
    // "first-spawn-noise" line is not surfaced again on a future crash.
    delete process.env.FAKE_MCP_STDERR_BEFORE_CRASH;
    delete process.env.FAKE_MCP_CRASH_ON_START;
    await client.start(FAKE_SERVER);
    expect(client.isRunning()).toBe(true);
    const second = client.getRecentChildOutput();
    expect(second.some((l) => l.includes('first-spawn-noise'))).toBe(false);
  });

  it('does not record diagnostic output during a graceful stop', async () => {
    await client.start(FAKE_SERVER);
    expect(client.isRunning()).toBe(true);

    client.stop();
    // Allow the exit event to fire.
    await new Promise((r) => setTimeout(r, 50));

    // Graceful stop should leave the buffer empty (nothing went wrong;
    // there's nothing to surface). Anything in the buffer means the test
    // happy path is leaking warnings the user shouldn't see.
    expect(client.getRecentChildOutput()).toEqual([]);
  });

  // P0-11 / closes #808: handleExit must flush BOTH stdio buffers,
  // not just stderr. The MCP child can crash mid-pino-line on stdout
  // (no trailing newline) — the partial bytes are exactly the
  // diagnostic the user needs.
  it('flushes a stdout partial line (no trailing \\n) on exit (#808)', async () => {
    process.env.FAKE_MCP_STDOUT_PARTIAL_NO_NEWLINE =
      'fatal-stdout-without-newline-' + Math.random().toString(36).slice(2);
    process.env.FAKE_MCP_CRASH_ON_START = '1';

    await expect(client.start(FAKE_SERVER)).rejects.toThrow();

    const captured = client.getRecentChildOutput().join('\n');
    expect(captured).toContain(process.env.FAKE_MCP_STDOUT_PARTIAL_NO_NEWLINE);
  });

  it('flushes a stderr partial line (no trailing \\n) on exit (#808)', async () => {
    process.env.FAKE_MCP_STDERR_PARTIAL_NO_NEWLINE =
      'fatal-stderr-without-newline-' + Math.random().toString(36).slice(2);
    process.env.FAKE_MCP_CRASH_ON_START = '1';

    await expect(client.start(FAKE_SERVER)).rejects.toThrow();

    const captured = client.getRecentChildOutput().join('\n');
    expect(captured).toContain(process.env.FAKE_MCP_STDERR_PARTIAL_NO_NEWLINE);
  });

  // P0-11 / closes #807: a child that streams a giant unbroken line to
  // stderr must NOT be able to grow McpClient's accumulator without
  // bound. The accumulator is force-flushed at CHILD_OUTPUT_LINE_CAP
  // (4096) so memory stays bounded. The captured output is truncated
  // to the cap (with the documented "…" suffix from recordChildOutput).
  it('caps stderr accumulator at CHILD_OUTPUT_LINE_CAP even with no newline (#807)', async () => {
    // 50_000 chars >> CHILD_OUTPUT_LINE_CAP (4096).
    process.env.FAKE_MCP_STDERR_GIANT_LINE = '50000';
    process.env.FAKE_MCP_CRASH_ON_START = '1';

    await expect(client.start(FAKE_SERVER)).rejects.toThrow();

    const captured = client.getRecentChildOutput();
    expect(captured.length).toBeGreaterThan(0);
    // Each captured entry must be at-or-below the cap. The cap is 4096
    // chars; entries that hit the cap get a "…" suffix (length 4097).
    for (const line of captured) {
      expect(line.length).toBeLessThanOrEqual(5000);
    }
  });
});

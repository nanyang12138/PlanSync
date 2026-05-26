#!/usr/bin/env node
/**
 * Minimal MCP-compatible JSON-RPC echo server for McpClient tests (R-021).
 *
 * Speaks just enough of the MCP wire protocol for `McpClient.start()` to
 * succeed: responds to `initialize`, `tools/list`, and `tools/call`.
 *
 * Crash modes controlled by env vars (used by the tests):
 *   FAKE_MCP_CRASH_ON_START=1          → exit immediately before reading stdin
 *   FAKE_MCP_CRASH_AFTER_INIT=1        → exit after replying to the first request
 *   FAKE_MCP_CRASH_AFTER_MS=<n>        → exit after <n> ms
 *   FAKE_MCP_CRASH_AFTER_REQUESTS=<n>  → exit after handling <n> requests total
 */

'use strict';

// PR-B: Optional pre-crash output. Lets tests verify that McpClient's
// diagnostic ring buffer captures what the child wrote (stderr text +
// pino-style structured JSON on stdout) and surfaces it on crash.
if (process.env.FAKE_MCP_STDERR_BEFORE_CRASH) {
  process.stderr.write(process.env.FAKE_MCP_STDERR_BEFORE_CRASH + '\n');
}
if (process.env.FAKE_MCP_STDOUT_PINO_BEFORE_CRASH) {
  // Mimics pino's default JSON shape: { level, time, msg, err: { type, message } }.
  process.stdout.write(
    JSON.stringify({
      level: 50,
      time: Date.now(),
      msg: 'MCP Server failed to start',
      err: {
        type: 'ReferenceError',
        message: process.env.FAKE_MCP_STDOUT_PINO_BEFORE_CRASH,
      },
    }) + '\n',
  );
}

// P0-11 / closes #808: emit a partial line with no trailing newline so
// the test can verify McpClient's exit handler flushes its readBuffer
// instead of silently dropping the bytes.
if (process.env.FAKE_MCP_STDOUT_PARTIAL_NO_NEWLINE) {
  process.stdout.write(process.env.FAKE_MCP_STDOUT_PARTIAL_NO_NEWLINE);
}
if (process.env.FAKE_MCP_STDERR_PARTIAL_NO_NEWLINE) {
  process.stderr.write(process.env.FAKE_MCP_STDERR_PARTIAL_NO_NEWLINE);
}

// P0-11 / closes #807: emit a single very long line (no newline) to
// verify McpClient force-flushes the buffer at the per-line cap and
// doesn't grow memory unboundedly.
if (process.env.FAKE_MCP_STDERR_GIANT_LINE) {
  const size = Number(process.env.FAKE_MCP_STDERR_GIANT_LINE);
  if (Number.isFinite(size) && size > 0) {
    process.stderr.write('X'.repeat(size));
  }
}

if (process.env.FAKE_MCP_CRASH_ON_START === '1') {
  // Give Node a tick to flush stdio so the child's bytes reach the
  // parent's data handlers before the close event fires (P0-11 / #792).
  setImmediate(() => process.exit(1));
}

if (process.env.FAKE_MCP_CRASH_AFTER_MS) {
  const ms = Number(process.env.FAKE_MCP_CRASH_AFTER_MS);
  if (Number.isFinite(ms) && ms >= 0) {
    setTimeout(() => process.exit(1), ms).unref();
  }
}

const crashAfterRequests = process.env.FAKE_MCP_CRASH_AFTER_REQUESTS
  ? Number(process.env.FAKE_MCP_CRASH_AFTER_REQUESTS)
  : null;

// R-022 one-shot crash file: when the test sets this env var to a path that
// exists, this spawn arms a single crash-on-tool-call AND deletes the marker
// so the next spawn (the auto-restart by McpClient.callTool) starts clean.
let crashOnNextToolCall = false;
if (process.env.FAKE_MCP_CRASH_ON_TOOL_CALL_ONCE_FILE) {
  const fs = require('fs');
  const file = process.env.FAKE_MCP_CRASH_ON_TOOL_CALL_ONCE_FILE;
  try {
    if (fs.existsSync(file)) {
      crashOnNextToolCall = true;
      fs.unlinkSync(file);
    }
  } catch {
    // Best-effort; if the FS check fails we just won't crash this spawn.
  }
}

let handled = 0;
let buf = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    if (msg.method === 'initialize') {
      reply(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: { logging: {} },
        serverInfo: { name: 'fake-mcp-server', version: '0.0.1' },
      });
      if (process.env.FAKE_MCP_CRASH_AFTER_INIT === '1') {
        setImmediate(() => process.exit(1));
        return;
      }
    } else if (msg.method === 'tools/list') {
      reply(msg.id, {
        tools: [
          {
            name: 'fake_tool',
            description: 'fake tool for tests',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });
    } else if (msg.method === 'tools/call') {
      if (process.env.FAKE_MCP_CRASH_ON_TOOL_CALL === '1') {
        // Exit without replying so the in-flight call stays in `pending`
        // until McpClient's exit handler rejects it with MCP_CRASHED.
        setImmediate(() => process.exit(1));
        return;
      }
      // R-022: a tool call with name `fake_error_tool` returns a JSON-RPC
      // error envelope. McpClient surfaces this as a plain Error (not
      // MCP_CRASHED), and the test asserts callTool does NOT auto-retry
      // because the failure is at the protocol layer, not the transport.
      const callName = msg.params && msg.params.name;
      if (callName === 'fake_error_tool') {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: 'fake-protocol-error' },
          }) + '\n',
        );
        handled += 1;
        return;
      }
      // R-022 one-shot crash mode: the test creates a marker file before the
      // first callTool attempt. The subprocess deletes the file at startup
      // (see top of this file); if it was present, this flag is armed for
      // the current spawn only. The next spawn (after McpClient restarts us)
      // will not see the file and will reply normally — letting the test
      // assert that callTool transparently recovered and returned a result.
      if (crashOnNextToolCall) {
        crashOnNextToolCall = false;
        setImmediate(() => process.exit(1));
        return;
      }
      // B9 / closes #871 #913 — when armed, return a tool result whose
      // `text` payload exceeds N kilobytes so the test can verify
      // McpClient's stdout partial-buffer no longer drops legitimate
      // large MCP frames at the per-line cap. We also write the
      // response in two chunks to specifically exercise the
      // "partial buffer crosses cap before newline arrives" path.
      if (callName === 'fake_giant_result_tool') {
        const sizeKb = Number(process.env.FAKE_MCP_GIANT_RESULT_KB || 16);
        const payloadText = 'A'.repeat(sizeKb * 1024);
        const frame =
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: payloadText }] },
          }) + '\n';
        // Split halfway and add a tiny delay so the parent's
        // `data` handler observes the partial buffer state.
        const half = Math.floor(frame.length / 2);
        process.stdout.write(frame.slice(0, half));
        setTimeout(() => process.stdout.write(frame.slice(half)), 5);
        handled += 1;
        return;
      }
      // R-005: when armed, push an `execution_aborted` notification BEFORE
      // replying to the tool call. McpClient's `setAbortHandler` should fire
      // even though the tool call itself succeeds, so callers can verify the
      // notification path is plumbed correctly without depending on a crash.
      if (process.env.FAKE_MCP_SEND_ABORT_ON_TOOL_CALL === '1') {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/message',
            params: {
              level: 'error',
              logger: 'plansync',
              data: {
                type: 'execution_aborted',
                code: 'RUN_STALE_VERSION',
                message: 'Run is stale: bound to plan v1, task now v2.',
                runId: 'fake-run-id',
                taskId: 'fake-task-id',
              },
            },
          }) + '\n',
        );
      }
      reply(msg.id, {
        content: [{ type: 'text', text: 'fake-result' }],
      });
    } else if (msg.method && msg.id !== undefined) {
      reply(msg.id, {});
    }

    handled += 1;
    if (crashAfterRequests !== null && handled >= crashAfterRequests) {
      setImmediate(() => process.exit(1));
      return;
    }
  }
});

process.stdin.on('end', () => process.exit(0));

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

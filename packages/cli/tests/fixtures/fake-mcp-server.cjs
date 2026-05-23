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

if (process.env.FAKE_MCP_CRASH_ON_START === '1') {
  process.exit(1);
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

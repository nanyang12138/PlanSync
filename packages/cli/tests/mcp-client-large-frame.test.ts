/**
 * Closes #871 #913 — McpClient.stdout's partial-line buffer must
 * accommodate legitimate MCP JSON-RPC frames that exceed the
 * per-line diagnostic cap (4 KiB). Pre-fix, any frame that arrived
 * in 2+ chunks AND grew the partial buffer past 4 KiB before the
 * trailing newline showed up was force-flushed as a diagnostic line
 * + dropped, which manifested as `request timed out` or
 * `tool result lost`.
 *
 * The fix raises the partial-buffer cap to 16 MiB while keeping
 * the per-line display cap at 4 KiB. The fake MCP server has a
 * `fake_giant_result_tool` mode that emits a tool result whose text
 * payload exceeds N KiB and writes it as two chunks separated by a
 * tiny setTimeout so we exercise exactly the "partial buffer
 * crosses cap before newline arrives" path.
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

describe('McpClient — stdout partial buffer accepts large MCP frames (#871 #913)', () => {
  let client: McpClient;

  beforeEach(() => {
    configureCfg();
    delete process.env.FAKE_MCP_GIANT_RESULT_KB;
    client = new McpClient();
    client._setSleepFnForTests(async () => {});
  });

  afterEach(() => {
    client.stop();
  });

  it('returns a 16 KiB JSON-RPC result without dropping the frame', async () => {
    process.env.FAKE_MCP_GIANT_RESULT_KB = '16';
    await client.start(FAKE_SERVER);

    // McpClient.callTool joins text-content items with '\n'; for a
    // single-item content array this returns just the text payload.
    // The payload must arrive intact — pre-fix the partial buffer
    // was clipped at 4 KiB and the rest treated as garbage, so the
    // parent's `pending` map would never resolve and the call would
    // time out.
    const text = await client.callTool('fake_giant_result_tool', {});
    expect(text).toMatch(/^A+$/);
    expect(text.length).toBe(16 * 1024);
  });

  it('returns a 256 KiB JSON-RPC result (well past the old 4 KiB cap)', async () => {
    process.env.FAKE_MCP_GIANT_RESULT_KB = '256';
    await client.start(FAKE_SERVER);

    const text = await client.callTool('fake_giant_result_tool', {});
    expect(text.length).toBe(256 * 1024);
    expect(text).toMatch(/^A+$/);
  });
});

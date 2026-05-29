/**
 * R-206 L2: tests for `packages/cli/src/abort-check.mjs`.
 *
 * The script is invoked from a Claude Code PreToolUse hook on every tool
 * call, so the wire-level contract that matters here is:
 *
 *   - HTTP 200 from /api/exec/abort-check → script exits 0
 *   - HTTP 409 → script exits 1 and writes the abort reason to stderr
 *     (so Claude Code can surface it in the interrupt notice)
 *   - Persistent network failure → script exits 1 (fail-closed, so a
 *     broken API can't silently bypass the gate)
 *
 * We test by spawning the script as a child process against a tiny local
 * http server we control on a random port. No mocking of node internals.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = join(__dirname, '..', 'src', 'abort-check.mjs');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runScript(env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

// Shape of the next response the mock server should send. Set per-test
// inside `beforeEach`; the server reads it on each request.
interface Plan {
  status: number;
  body: string;
  /** When set, the server destroys the socket without responding for `failures`
   *  consecutive requests before honoring `status`/`body`. Simulates network errors. */
  failures?: number;
}
let plan: Plan = { status: 200, body: '{"aborted":false}' };
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    expect(req.url).toBe('/api/exec/abort-check');
    expect(req.headers.authorization).toBe('Bearer test-key');
    if (plan.failures && plan.failures > 0) {
      plan.failures -= 1;
      req.socket.destroy();
      return;
    }
    res.writeHead(plan.status, { 'Content-Type': 'application/json' });
    res.end(plan.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  plan = { status: 200, body: '{"aborted":false}' };
});

describe('abort-check.mjs — wire contract for Claude Code hook', () => {
  it('200 response → exit 0, no stderr', async () => {
    plan = { status: 200, body: '{"aborted":false,"status":"running"}' };
    const r = await runScript({ PLANSYNC_API_URL: baseUrl, PLANSYNC_API_KEY: 'test-key' });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('409 with reason=task_gated → exit 1 + stderr includes the reason and gate', async () => {
    plan = {
      status: 409,
      body: '{"aborted":true,"reason":"task_gated","executionGate":"drift_high"}',
    };
    const r = await runScript({ PLANSYNC_API_URL: baseUrl, PLANSYNC_API_KEY: 'test-key' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/PlanSync execution aborted/);
    expect(r.stderr).toMatch(/task_gated/);
    expect(r.stderr).toMatch(/drift_high/);
  });

  it('409 with reason=run_paused → exit 1 + stderr includes reason', async () => {
    plan = { status: 409, body: '{"aborted":true,"reason":"run_paused"}' };
    const r = await runScript({ PLANSYNC_API_URL: baseUrl, PLANSYNC_API_KEY: 'test-key' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/run_paused/);
  });

  it('persistent network failure → exit 1 (fail-closed)', async () => {
    // Always destroy the socket — beyond the 3-attempt retry budget.
    plan = { status: 200, body: '{}', failures: 99 };
    const r = await runScript({ PLANSYNC_API_URL: baseUrl, PLANSYNC_API_KEY: 'test-key' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/abort-check: API unreachable/);
  });

  it('transient failure recovers within the retry budget (2 failures, then 200) → exit 0', async () => {
    plan = { status: 200, body: '{"aborted":false}', failures: 2 };
    const r = await runScript({ PLANSYNC_API_URL: baseUrl, PLANSYNC_API_KEY: 'test-key' });
    expect(r.exitCode).toBe(0);
  });

  it('missing PLANSYNC_API_KEY → exit 1, helpful stderr (fail-closed)', async () => {
    const r = await runScript({
      PLANSYNC_API_URL: baseUrl,
      // Override anything inherited from the parent process env so we
      // genuinely test the empty-key branch.
      PLANSYNC_API_KEY: '',
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/PLANSYNC_API_KEY is not set/);
  });

  it('5xx → exit 1 (treated as transient and retried, then fail-closed)', async () => {
    plan = { status: 500, body: 'oops' };
    const r = await runScript({ PLANSYNC_API_URL: baseUrl, PLANSYNC_API_KEY: 'test-key' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/unexpected HTTP 500/);
  });
});

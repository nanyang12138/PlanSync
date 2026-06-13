/**
 * R-206 L2: tests for `packages/cli/src/abort-check.mjs`.
 *
 * The script is invoked from a Claude Code PreToolUse hook on every tool
 * call. Claude Code's PreToolUse contract only BLOCKS the tool when the hook
 * exits with code **2** — any other non-zero code is a non-blocking warning
 * that lets the tool run anyway. The wire-level contract that matters here is
 * therefore context-dependent:
 *
 *   EXEC session (PLANSYNC_EXEC_RUN_ID set — a real /exec run to protect):
 *     - HTTP 200 healthy                       → exit 0
 *     - HTTP 409 (aborted)                     → exit 2 + reason on stderr
 *     - 200 no_exec_context (key swapped down) → exit 2 (fail-closed)
 *     - persistent network failure / 5xx       → exit 2 (fail-closed)
 *     - missing PLANSYNC_API_KEY               → exit 2 (fail-closed)
 *
 *   NON-exec session (no marker — an ordinary developer in the repo):
 *     - there is no run to gate, and this hook fires before EVERY tool call,
 *       so it MUST be a harmless no-op: it never blocks (exit 0), even on a
 *       config/transport failure. Bricking every tool call in a normal repo
 *       session because the PlanSync API is down is not acceptable.
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

const RUN_ID = 'run_123'; // marks an exec session in the tests below

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

describe('abort-check.mjs — EXEC session (PLANSYNC_EXEC_RUN_ID set) blocks with exit 2', () => {
  const execEnv = (extra: NodeJS.ProcessEnv = {}) => ({
    PLANSYNC_API_URL: baseUrl,
    PLANSYNC_API_KEY: 'test-key',
    PLANSYNC_EXEC_RUN_ID: RUN_ID,
    ...extra,
  });

  it('200 healthy → exit 0, no stderr', async () => {
    plan = { status: 200, body: '{"aborted":false,"status":"running","executionGate":null}' };
    const r = await runScript(execEnv());
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('409 reason=task_gated → exit 2 (BLOCKS) + stderr includes reason and gate', async () => {
    plan = {
      status: 409,
      body: '{"aborted":true,"reason":"task_gated","executionGate":"drift_high"}',
    };
    const r = await runScript(execEnv());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/PlanSync execution aborted/);
    expect(r.stderr).toMatch(/task_gated/);
    expect(r.stderr).toMatch(/drift_high/);
  });

  it('409 reason=run_paused → exit 2 (BLOCKS) + stderr includes reason', async () => {
    plan = { status: 409, body: '{"aborted":true,"reason":"run_paused"}' };
    const r = await runScript(execEnv());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/run_paused/);
  });

  it('persistent network failure → exit 2 (fail-closed BLOCK)', async () => {
    plan = { status: 200, body: '{}', failures: 99 };
    const r = await runScript(execEnv());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/abort-check: API unreachable/);
  });

  it('transient failure recovers within retry budget (2 failures, then 200) → exit 0', async () => {
    plan = { status: 200, body: '{"aborted":false}', failures: 2 };
    const r = await runScript(execEnv());
    expect(r.exitCode).toBe(0);
  });

  it('missing PLANSYNC_API_KEY → exit 2 (fail-closed BLOCK) + helpful stderr', async () => {
    const r = await runScript(execEnv({ PLANSYNC_API_KEY: '' }));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/PLANSYNC_API_KEY is not set/);
  });

  it('5xx → exit 2 (treated as transient, retried, then fail-closed BLOCK)', async () => {
    plan = { status: 500, body: 'oops' };
    const r = await runScript(execEnv());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/unexpected HTTP 500/);
  });

  it('200 no_exec_context (exec-scoped key swapped down) → exit 2 (fail-closed BLOCK)', async () => {
    // In an exec session, a no_exec_context answer means the exec-scoped key was
    // swapped for a plain one — the gate is silently downgraded to a no-op. Fail closed.
    plan = { status: 200, body: '{"aborted":false,"reason":"no_exec_context"}' };
    const r = await runScript(execEnv());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/not exec-scoped/);
    expect(r.stderr).toMatch(/failing closed/);
  });
});

describe('abort-check.mjs — NON-exec session (no marker) is a harmless no-op (never blocks)', () => {
  const plainEnv = (extra: NodeJS.ProcessEnv = {}) => ({
    PLANSYNC_API_URL: baseUrl,
    PLANSYNC_API_KEY: 'test-key',
    PLANSYNC_EXEC_RUN_ID: '', // explicitly NOT an exec session
    ...extra,
  });

  it('200 no_exec_context → exit 0', async () => {
    plan = { status: 200, body: '{"aborted":false,"reason":"no_exec_context"}' };
    const r = await runScript(plainEnv());
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('persistent network failure → exit 0 (does NOT brick an ordinary session)', async () => {
    plan = { status: 200, body: '{}', failures: 99 };
    const r = await runScript(plainEnv());
    expect(r.exitCode).toBe(0);
  });

  it('missing PLANSYNC_API_KEY → exit 0 (warns on stderr but never blocks)', async () => {
    const r = await runScript(plainEnv({ PLANSYNC_API_KEY: '' }));
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/PLANSYNC_API_KEY is not set/);
  });
});

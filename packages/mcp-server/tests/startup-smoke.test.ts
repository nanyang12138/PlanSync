/**
 * MCP server startup smoke test.
 *
 * Spawns the **bundled** `dist/index.js` exactly the way `bin/plansync`
 * spawns it from `packages/cli/src/mcp-client.ts`, then asserts:
 *
 *   1. The child does not exit within `STARTUP_GRACE_MS` of being spawned
 *      (i.e. `main()` finished successfully and the process is now
 *      idling on stdin waiting for JSON-RPC frames).
 *   2. If the child does exit early, the captured stderr is surfaced in
 *      the failure message so the next person to break startup gets a
 *      copy-pasteable repro instead of an opaque "subprocess exited
 *      (code 1)".
 *
 * Why this exists
 * ---------------
 * mcp-server's CI typecheck job is intentionally skipped (R-132): the
 * combination of `@modelcontextprotocol/sdk` + Zod 3.x + TS 5.7 triggers
 * TS2589 type-recursion explosions that blow tsc heap past 8 GB.
 * `npm run build` uses esbuild, which **bundles without type-checking**.
 * That stack means the only way a missing import / undefined symbol /
 * syntax error in mcp-server reaches users is to spawn the bundle and
 * watch it boot — exactly what this test does.
 *
 * The recent R-171 follow-up (PR #746) was caught only after a real
 * user hit `MCP_CRASHED: subprocess exited (code 1)` because two
 * helpers (`readEnforceMode`, `ExecStateManager`) were referenced in
 * `index.ts` without being imported. Both `npm run build` and CI passed
 * because no stage actually attempted to *run* the resulting bundle.
 * This test closes that hole.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const BUNDLE = resolve(PKG_ROOT, 'dist/index.js');

// Generous enough to cover slow CI runners, short enough that a real
// startup crash (which exits in <100ms) is still detected promptly.
const STARTUP_GRACE_MS = 2_000;

function buildIfMissing(): void {
  if (existsSync(BUNDLE)) return;
  // Fall back to building on-demand so the test is robust to fresh
  // checkouts where the test job did not pre-build mcp-server.
  const r = spawnSync('npm', ['run', 'build', '--workspace=@plansync/mcp-server'], {
    cwd: resolve(PKG_ROOT, '../..'),
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    throw new Error(`mcp-server build failed: ${r.stderr || r.stdout}`);
  }
}

interface StartResult {
  child: ChildProcessWithoutNullStreams;
  exitedEarly: { code: number | null; signal: NodeJS.Signals | null } | null;
  stderr: string;
}

async function spawnBundleAndObserve(env: NodeJS.ProcessEnv): Promise<StartResult> {
  const child = spawn(process.execPath, [BUNDLE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // R-041 follow-up: pino logs ride on stdout (the JSON-RPC channel),
    // so a real startup error in the bundle ends up there too. We pipe
    // both streams and merge them into `stderr` for the failure message.
    env: { ...env },
  });

  let merged = '';
  child.stdout.on('data', (b: Buffer) => (merged += b.toString()));
  child.stderr.on('data', (b: Buffer) => (merged += b.toString()));

  let exitedEarly: StartResult['exitedEarly'] = null;
  child.on('exit', (code, signal) => {
    exitedEarly = { code, signal };
  });

  await new Promise((r) => setTimeout(r, STARTUP_GRACE_MS));
  return { child, exitedEarly, stderr: merged };
}

function killChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}

describe('MCP server: bundled dist/index.js boots without crashing', () => {
  beforeAll(() => {
    buildIfMissing();
  });

  // Track every spawned child so a hung test cannot leak a zombie
  // process into the next test run.
  const spawned: ChildProcessWithoutNullStreams[] = [];
  afterAll(() => {
    for (const c of spawned) killChild(c);
  });

  it('boots cleanly with PLANSYNC_API_KEY set (the normal CLI path)', async () => {
    const result = await spawnBundleAndObserve({
      PLANSYNC_API_URL: 'http://localhost:3001',
      PLANSYNC_API_KEY: 'smoke-test-key',
      PLANSYNC_USER: 'smoke',
      PLANSYNC_PROJECT: 'smoke-project',
      PLANSYNC_MCP_DISABLE_SSE: '1',
      LOG_LEVEL: 'error',
      // PATH so node + esbuild loaders work on the CI runner.
      PATH: process.env.PATH,
    });
    spawned.push(result.child);

    if (result.exitedEarly) {
      throw new Error(
        `MCP server crashed during startup ` +
          `(code=${result.exitedEarly.code}, signal=${result.exitedEarly.signal}).\n` +
          `Captured output:\n${result.stderr || '(empty)'}`,
      );
    }

    expect(result.child.exitCode).toBeNull();
    killChild(result.child);
  });

  it('boots cleanly with AUTH_DISABLED=true (local-dev / no-auth path)', async () => {
    const result = await spawnBundleAndObserve({
      PLANSYNC_API_URL: 'http://localhost:3001',
      AUTH_DISABLED: 'true',
      PLANSYNC_USER: 'smoke',
      PLANSYNC_MCP_DISABLE_SSE: '1',
      LOG_LEVEL: 'error',
      PATH: process.env.PATH,
    });
    spawned.push(result.child);

    if (result.exitedEarly) {
      throw new Error(
        `MCP server crashed during startup with AUTH_DISABLED=true ` +
          `(code=${result.exitedEarly.code}, signal=${result.exitedEarly.signal}).\n` +
          `Captured output:\n${result.stderr || '(empty)'}`,
      );
    }

    expect(result.child.exitCode).toBeNull();
    killChild(result.child);
  });

  it('exits non-zero (and never silently hangs) when PLANSYNC_API_KEY is missing', async () => {
    // Counter-test: confirms the smoke harness *would* notice a real
    // startup failure. With no PLANSYNC_API_KEY and no AUTH_DISABLED,
    // R-040 fails fast; the harness should observe an early exit.
    const result = await spawnBundleAndObserve({
      PLANSYNC_API_URL: 'http://localhost:3001',
      PLANSYNC_USER: 'smoke',
      PLANSYNC_MCP_DISABLE_SSE: '1',
      LOG_LEVEL: 'error',
      PATH: process.env.PATH,
    });
    spawned.push(result.child);

    expect(result.exitedEarly).not.toBeNull();
    expect(result.exitedEarly!.code).toBe(1);
    // The real R-040 message must reach stdout (pino) so smoke failure
    // surfaces a usable diagnostic rather than just "code 1".
    expect(result.stderr).toMatch(/PLANSYNC_API_KEY is not set/);
  });
});

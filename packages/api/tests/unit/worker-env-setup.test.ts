import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const TS_NODE = resolve(REPO_ROOT, 'node_modules/.bin/ts-node');
const SETUP = resolve(__dirname, '../../scripts/worker-env-setup.ts');

/**
 * Closes #232 / #265 / #273.
 *
 * The worker's only output is eventBus.publish; if PLANSYNC_EVENT_BUS
 * resolves to 'memory' on the worker host, the scanner publishes events
 * to a process-local bus and SSE subscribers in the API process see
 * nothing. worker-env-setup.ts is loaded via node --require BEFORE
 * run-worker.ts and any module that creates the bus singleton, so the
 * singleton always picks the cross-process backend.
 *
 * Tests run the setup file via ts-node in a sub-process so the env
 * mutation is observable as the child's process.env.
 */
function runSetup(env: Record<string, string | undefined>): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  // -e: print the resolved PLANSYNC_EVENT_BUS after setup runs.
  const code = `require('${SETUP.replace(/\\/g, '\\\\')}'); console.log(JSON.stringify({ bus: process.env.PLANSYNC_EVENT_BUS ?? null }));`;
  // Filter env: spawnSync requires an env object; we want a controlled
  // baseline that includes PATH + HOME so node can boot, plus the
  // overrides under test.
  const baseEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_PATH: process.env.NODE_PATH ?? '',
  };
  const fullEnv = { ...baseEnv, ...env };
  // Use ts-node directly so the .ts file is transpiled on the fly.
  const r = spawnSync(TS_NODE, ['--compiler-options', '{"module":"commonjs"}', '-e', code], {
    env: fullEnv as unknown as NodeJS.ProcessEnv,
    encoding: 'utf-8',
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

describe('scripts/worker-env-setup.ts (#232 / #265 / #273)', () => {
  it('defaults PLANSYNC_EVENT_BUS to "postgres" when unset', () => {
    const { stdout, stderr, status } = runSetup({});
    expect(status, `stderr was: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(parsed.bus).toBe('postgres');
  });

  it('honours an explicit PLANSYNC_EVENT_BUS=memory (operator opt-out)', () => {
    const { stdout, status } = runSetup({ PLANSYNC_EVENT_BUS: 'memory' });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(parsed.bus).toBe('memory');
  });

  it('honours an explicit PLANSYNC_EVENT_BUS=postgres (no-op)', () => {
    const { stdout, status } = runSetup({ PLANSYNC_EVENT_BUS: 'postgres' });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(parsed.bus).toBe('postgres');
  });

  // ---- #571 / #572 / #605 / #608: dotenv-before-default ordering ---------

  function buildTempRepoWithEnv(envFileBody: string): { tmp: string; tempSetup: string } {
    // Build a temp repo-shaped layout so worker-env-setup.ts's
    // load-dotenv.ts finds the .env at ../../../.env relative to the
    // SETUP file path. We can't easily mock that path inside a sub-
    // process, so we mirror packages/api/scripts/* and copy the two
    // source files in. Tradeoff vs a real mock library: zero new deps,
    // exercises the real path resolution.
    const tmp = fs.mkdtempSync(join(os.tmpdir(), 'plansync-worker-env-'));
    const scriptsDir = join(tmp, 'packages/api/scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(SETUP, join(scriptsDir, 'worker-env-setup.ts'));
    fs.copyFileSync(
      resolve(__dirname, '../../scripts/load-dotenv.ts'),
      join(scriptsDir, 'load-dotenv.ts'),
    );
    fs.writeFileSync(join(tmp, '.env'), envFileBody);
    return { tmp, tempSetup: join(scriptsDir, 'worker-env-setup.ts') };
  }

  it('#571/#605/#608: a .env file PLANSYNC_EVENT_BUS=memory is honoured (loaded before the default fires)', () => {
    const { tmp, tempSetup } = buildTempRepoWithEnv(
      '# operator override\nPLANSYNC_EVENT_BUS=memory\n',
    );
    try {
      const code = `require('${tempSetup.replace(/\\/g, '\\\\')}'); console.log(JSON.stringify({ bus: process.env.PLANSYNC_EVENT_BUS ?? null }));`;
      const r = spawnSync(TS_NODE, ['--compiler-options', '{"module":"commonjs"}', '-e', code], {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          NODE_PATH: process.env.NODE_PATH ?? '',
        } as unknown as NodeJS.ProcessEnv,
        encoding: 'utf-8',
      });
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      const parsed = JSON.parse((r.stdout ?? '').trim().split('\n').pop()!);
      // Pre-fix value: 'postgres' (default ran before .env was loaded).
      expect(parsed.bus).toBe('memory');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('shell env beats .env (env > .env)', () => {
    const { tmp, tempSetup } = buildTempRepoWithEnv('PLANSYNC_EVENT_BUS=memory\n');
    try {
      const code = `require('${tempSetup.replace(/\\/g, '\\\\')}'); console.log(JSON.stringify({ bus: process.env.PLANSYNC_EVENT_BUS ?? null }));`;
      const r = spawnSync(TS_NODE, ['--compiler-options', '{"module":"commonjs"}', '-e', code], {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          NODE_PATH: process.env.NODE_PATH ?? '',
          // Explicit shell env value MUST win over the .env file value.
          PLANSYNC_EVENT_BUS: 'postgres',
        } as unknown as NodeJS.ProcessEnv,
        encoding: 'utf-8',
      });
      expect(r.status).toBe(0);
      const parsed = JSON.parse((r.stdout ?? '').trim().split('\n').pop()!);
      expect(parsed.bus).toBe('postgres');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does NOT touch other env vars', () => {
    const code = `require('${SETUP.replace(/\\/g, '\\\\')}'); console.log(JSON.stringify({ a: process.env.SENTINEL_A, b: process.env.SENTINEL_B }));`;
    const r = spawnSync(TS_NODE, ['--compiler-options', '{"module":"commonjs"}', '-e', code], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        SENTINEL_A: 'x',
        SENTINEL_B: 'y',
      } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    const parsed = JSON.parse((r.stdout ?? '').trim().split('\n').pop()!);
    expect(parsed.a).toBe('x');
    expect(parsed.b).toBe('y');
  });
});

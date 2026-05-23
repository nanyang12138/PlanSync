import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
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
    env: fullEnv as NodeJS.ProcessEnv,
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

  it('does NOT touch other env vars', () => {
    const code = `require('${SETUP.replace(/\\/g, '\\\\')}'); console.log(JSON.stringify({ a: process.env.SENTINEL_A, b: process.env.SENTINEL_B }));`;
    const r = spawnSync(TS_NODE, ['--compiler-options', '{"module":"commonjs"}', '-e', code], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        SENTINEL_A: 'x',
        SENTINEL_B: 'y',
      } as NodeJS.ProcessEnv,
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    const parsed = JSON.parse((r.stdout ?? '').trim().split('\n').pop()!);
    expect(parsed.a).toBe('x');
    expect(parsed.b).toBe('y');
  });
});

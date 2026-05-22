import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Repo root: packages/api/tests/unit -> ../../../..
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const HELPER = path.join(REPO_ROOT, 'scripts/next-cache-helper.sh');

let workDir: string;

function run(
  cmd: string,
  env: Record<string, string | undefined> = {},
): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync('bash', ['-c', cmd], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return {
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
    status: res.status,
  };
}

function shouldClear(buildDir: string, ...inputs: string[]): boolean {
  const args = [buildDir, ...inputs].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  const { status } = run(`. "${HELPER}" && should_clear_next_cache ${args}`);
  // Exit 0 means "clear", exit 1 means "keep" — surface that as a boolean.
  return status === 0;
}

function writeMarker(buildDir: string, ...inputs: string[]): { status: number | null } {
  const args = [buildDir, ...inputs].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  const res = run(`. "${HELPER}" && write_next_cache_marker ${args}`);
  return { status: res.status };
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'plansync-next-cache-'));
});

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe('scripts/next-cache-helper.sh — should_clear_next_cache (R-103)', () => {
  it('returns "keep" when the build dir does not exist (first run, nothing to clear)', () => {
    const buildDir = path.join(workDir, 'never-built');
    const cfg = path.join(workDir, 'next.config.js');
    writeFileSync(cfg, 'module.exports = {};');

    expect(shouldClear(buildDir, cfg)).toBe(false);
  });

  it('returns "clear" when an existing build dir has no marker (pre-R-103 cache must be invalidated once)', () => {
    const buildDir = path.join(workDir, 'build');
    mkdirSync(buildDir, { recursive: true });
    const cfg = path.join(workDir, 'next.config.js');
    writeFileSync(cfg, 'module.exports = {};');

    expect(shouldClear(buildDir, cfg)).toBe(true);
  });

  it('returns "keep" when the marker hash matches the current config', () => {
    const buildDir = path.join(workDir, 'build');
    mkdirSync(buildDir, { recursive: true });
    const cfg = path.join(workDir, 'next.config.js');
    writeFileSync(cfg, 'module.exports = { foo: 1 };');

    const wm = writeMarker(buildDir, cfg);
    expect(wm.status).toBe(0);

    expect(shouldClear(buildDir, cfg)).toBe(false);
  });

  it('returns "clear" when the config file changes after the marker was written', () => {
    const buildDir = path.join(workDir, 'build');
    mkdirSync(buildDir, { recursive: true });
    const cfg = path.join(workDir, 'next.config.js');
    writeFileSync(cfg, 'module.exports = { foo: 1 };');
    writeMarker(buildDir, cfg);

    writeFileSync(cfg, 'module.exports = { foo: 2 };');

    expect(shouldClear(buildDir, cfg)).toBe(true);
  });

  it('hashes multiple config files together so changing any one of them triggers a clear', () => {
    const buildDir = path.join(workDir, 'build');
    mkdirSync(buildDir, { recursive: true });
    const cfg1 = path.join(workDir, 'next.config.js');
    const cfg2 = path.join(workDir, 'package.json');
    writeFileSync(cfg1, 'module.exports = { foo: 1 };');
    writeFileSync(cfg2, '{"name":"x","version":"1.0.0"}');
    writeMarker(buildDir, cfg1, cfg2);

    expect(shouldClear(buildDir, cfg1, cfg2)).toBe(false);

    writeFileSync(cfg2, '{"name":"x","version":"2.0.0"}');
    expect(shouldClear(buildDir, cfg1, cfg2)).toBe(true);
  });

  it('write_next_cache_marker stores a hex sha256 inside the build dir', () => {
    const buildDir = path.join(workDir, 'build');
    mkdirSync(buildDir, { recursive: true });
    const cfg = path.join(workDir, 'next.config.js');
    writeFileSync(cfg, 'module.exports = { foo: 1 };');

    const wm = writeMarker(buildDir, cfg);
    expect(wm.status).toBe(0);

    const markerPath = path.join(buildDir, '.plansync-next-config.sha256');
    expect(existsSync(markerPath)).toBe(true);
    const contents = readFileSync(markerPath, 'utf8').trim();
    expect(contents).toMatch(/^[0-9a-f]{64}$/);
  });

  it('write_next_cache_marker is a no-op when the build dir does not exist (no panic, no spurious files)', () => {
    const ghost = path.join(workDir, 'ghost-build');
    const cfg = path.join(workDir, 'next.config.js');
    writeFileSync(cfg, 'module.exports = {};');

    const { status } = writeMarker(ghost, cfg);
    expect(status).toBe(0);
    expect(existsSync(ghost)).toBe(false);
  });

  it('treats a custom marker filename via PLANSYNC_NEXT_CACHE_MARKER_NAME (test isolation knob)', () => {
    const buildDir = path.join(workDir, 'build');
    mkdirSync(buildDir, { recursive: true });
    const cfg = path.join(workDir, 'next.config.js');
    writeFileSync(cfg, 'module.exports = {};');

    const args = [buildDir, cfg].map((a) => `'${a}'`).join(' ');
    const env = { PLANSYNC_NEXT_CACHE_MARKER_NAME: '.custom-marker' };
    const wm = run(`. "${HELPER}" && write_next_cache_marker ${args}`, env);
    expect(wm.status).toBe(0);
    expect(existsSync(path.join(buildDir, '.custom-marker'))).toBe(true);

    const sc = run(`. "${HELPER}" && should_clear_next_cache ${args}`, env);
    // marker is present + matches => exit 1 (don't clear)
    expect(sc.status).toBe(1);
  });
});

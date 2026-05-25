/**
 * F1 / closes the dev.sh ↔ next.config.js USER fallback consistency
 * cluster (#287 / #289 / #366 / #540 / #567 + 3 sibling findings).
 *
 * The fallback chain implemented in next.config.js is:
 *
 *     PLANSYNC_BUILD_USER → USER → 'shared'
 *
 * dev.sh and build.sh now resolve and export PLANSYNC_BUILD_USER with
 * the same precedence (PLANSYNC_BUILD_USER → USER → whoami) so the
 * Node-side and shell-side compute the same string. We assert the
 * Node-side resolution here; the shell side is asserted by inspecting
 * dev.sh + build.sh source.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const ENV_KEYS = ['PLANSYNC_BUILD_USER', 'USER'] as const;
const saved: Record<string, string | undefined> = {};

function snapshotEnv() {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function loadNextConfig(): { distDir: string } {
  // next.config.js is a CJS module that reads process.env at require()
  // time, so we cache-bust by deleting it from require.cache between
  // setups.
  const configPath = path.resolve(__dirname, '../../next.config.js');
  delete require.cache[configPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(configPath) as { distDir: string };
}

describe('F1 next.config.js distDir resolution', () => {
  beforeEach(() => snapshotEnv());
  afterEach(() => restoreEnv());

  it('uses PLANSYNC_BUILD_USER when set (preferred over USER)', () => {
    process.env.PLANSYNC_BUILD_USER = 'cron-builder';
    process.env.USER = 'whatever';
    const cfg = loadNextConfig();
    expect(cfg.distDir).toBe(path.join('tmp', 'ps-next-build-cron-builder'));
  });

  it('falls back to USER when PLANSYNC_BUILD_USER is unset', () => {
    delete process.env.PLANSYNC_BUILD_USER;
    process.env.USER = 'alice';
    const cfg = loadNextConfig();
    expect(cfg.distDir).toBe(path.join('tmp', 'ps-next-build-alice'));
  });

  it('falls back to "shared" when both PLANSYNC_BUILD_USER and USER are unset', () => {
    delete process.env.PLANSYNC_BUILD_USER;
    delete process.env.USER;
    const cfg = loadNextConfig();
    expect(cfg.distDir).toBe(path.join('tmp', 'ps-next-build-shared'));
  });

  it('treats whitespace-only env values the same as unset', () => {
    process.env.PLANSYNC_BUILD_USER = '   ';
    process.env.USER = '   ';
    const cfg = loadNextConfig();
    expect(cfg.distDir).toBe(path.join('tmp', 'ps-next-build-shared'));
  });
});

describe('F1 shell entry points export PLANSYNC_BUILD_USER consistently', () => {
  // Static-source guard — if a future refactor drops the export from
  // dev.sh or build.sh, the on-disk distDir would silently diverge
  // again. Catching it here keeps the contract in one place.
  function readShellSource(rel: string): string {
    return fs.readFileSync(path.resolve(__dirname, '../../../../', rel), 'utf8');
  }

  it('dev.sh resolves PLANSYNC_BUILD_USER → USER → whoami and exports both', () => {
    const src = readShellSource('scripts/dev.sh');
    expect(src).toMatch(/export PLANSYNC_BUILD_USER="\$\{PLANSYNC_BUILD_USER:-\$\{USER:-\$\(whoami\)\}\}"/);
    expect(src).toMatch(/export USER="\$PLANSYNC_BUILD_USER"/);
  });

  it('build.sh resolves PLANSYNC_BUILD_USER → USER → whoami and exports both', () => {
    const src = readShellSource('scripts/build.sh');
    expect(src).toMatch(/export PLANSYNC_BUILD_USER="\$\{PLANSYNC_BUILD_USER:-\$\{USER:-\$\(whoami\)\}\}"/);
    expect(src).toMatch(/export USER="\$PLANSYNC_BUILD_USER"/);
  });
});

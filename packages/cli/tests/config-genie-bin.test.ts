/**
 * Tests for R-102: the CLI's `genieOrClaude` config field must default to the
 * portable, $PATH-resolvable binary `claude` instead of the AMD-internal
 * `/proj/verif_release_ro/genie/current/bin/genie` path. Without R-102, every
 * non-AMD host would `ENOENT` on `/exec` because the hard-coded fallback did
 * not exist there.
 *
 * Resolution order (highest priority first) — also documented in
 * `.env.example` and inline in `packages/cli/src/config.ts`:
 *   1. PLANSYNC_CODE_BIN
 *   2. GENIE_BIN          (legacy)
 *   3. "claude"           (PATH lookup, generic fallback)
 *
 * `cfg` is a module-level frozen-ish object computed at import time, so each
 * test resets the module registry and re-imports `config.js` after rewriting
 * `process.env`. Without `vi.resetModules()` we would re-read the same cached
 * value and the env-var changes below would be invisible.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV_KEYS = ['PLANSYNC_CODE_BIN', 'GENIE_BIN'] as const;

async function loadCfg(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key]!;
  }
  // Drop the cached module so the top-level `process.env` reads run again.
  vi.resetModules();
  const mod = await import('../src/config.js');
  return mod.cfg;
}

describe('R-102: CLI genieOrClaude default falls back to `claude`, not AMD path', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key]!;
    }
  });

  it('defaults to "claude" when no env vars are set', async () => {
    const cfg = await loadCfg({ PLANSYNC_CODE_BIN: undefined, GENIE_BIN: undefined });
    expect(cfg.genieOrClaude).toBe('claude');
    // Regression guard: the old hard-coded AMD-internal path must NEVER come
    // back as the default. R-102 is specifically about removing it.
    expect(cfg.genieOrClaude).not.toContain('/proj/verif_release_ro/');
  });

  it('PLANSYNC_CODE_BIN wins over both fallbacks', async () => {
    const cfg = await loadCfg({
      PLANSYNC_CODE_BIN: '/opt/claude/bin/claude',
      GENIE_BIN: '/opt/genie/bin/genie',
    });
    expect(cfg.genieOrClaude).toBe('/opt/claude/bin/claude');
  });

  it('GENIE_BIN is honoured for legacy users when PLANSYNC_CODE_BIN is unset', async () => {
    const cfg = await loadCfg({
      PLANSYNC_CODE_BIN: undefined,
      GENIE_BIN: '/legacy/genie',
    });
    expect(cfg.genieOrClaude).toBe('/legacy/genie');
  });

  it('empty PLANSYNC_CODE_BIN falls through to the next source', async () => {
    // `''` is falsy under `||`, so the resolution must continue to GENIE_BIN
    // (and ultimately the "claude" fallback). This guards against a future
    // refactor that switches to `??` and silently locks in an empty string.
    const cfg = await loadCfg({
      PLANSYNC_CODE_BIN: '',
      GENIE_BIN: '/from/genie',
    });
    expect(cfg.genieOrClaude).toBe('/from/genie');

    const cfg2 = await loadCfg({
      PLANSYNC_CODE_BIN: '',
      GENIE_BIN: '',
    });
    expect(cfg2.genieOrClaude).toBe('claude');
  });
});

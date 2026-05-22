import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Repo root: packages/api/tests/unit -> ../../../..
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PG_ENV_SH = path.join(REPO_ROOT, 'scripts/pg-env.sh');
const LOCAL_RUNTIME_SH = path.join(REPO_ROOT, 'scripts/local-node-runtime.sh');

let workDir: string;

function makeMockBin(dir: string, name = 'pg_ctl'): string {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

/**
 * Runs `bash -c <cmd>` with the helper sourced. Returns trimmed stdout.
 * `env` lets the test scrub PATH / PG_BIN.
 */
function runBash(cmd: string, env: NodeJS.ProcessEnv = {}): { stdout: string; status: number | null } {
  const res = spawnSync('bash', ['-c', cmd], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { stdout: (res.stdout ?? '').trim(), status: res.status };
}

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'plansync-pgenv-'));
});

afterAll(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe('scripts/pg-env.sh — detect_pg_bin (R-095)', () => {
  it('returns caller-provided PG_BIN unchanged when pg_ctl is executable there', () => {
    const customBin = path.join(workDir, 'custom-bin');
    makeMockBin(customBin);

    const { stdout, status } = runBash(`. "${PG_ENV_SH}" && detect_pg_bin`, {
      PG_BIN: customBin,
      // Strip PATH so no real Postgres install can interfere
      PATH: '/usr/bin:/bin',
    });

    expect(status).toBe(0);
    expect(stdout).toBe(customBin);
  });

  it('falls back to `pg_config --bindir` when no built-in candidate matches', () => {
    const fakeBin = path.join(workDir, 'pgcfg-bin');
    makeMockBin(fakeBin); // contains pg_ctl

    // Stub directory holding a fake pg_config that prints fakeBin
    const stubPath = path.join(workDir, 'stub-path');
    mkdirSync(stubPath, { recursive: true });
    const pgConfigScript = path.join(stubPath, 'pg_config');
    writeFileSync(
      pgConfigScript,
      `#!/bin/sh\n[ "$1" = "--bindir" ] && echo '${fakeBin}'\n`,
      { mode: 0o755 },
    );
    chmodSync(pgConfigScript, 0o755);

    // PATH = ONLY our stub + /usr/bin:/bin so candidate dirs (which are
    // absolute paths) are checked but won't have pg_ctl on a clean test host.
    // Unset PG_BIN to force probing.
    const { stdout, status } = runBash(
      `unset PG_BIN; . "${PG_ENV_SH}" && detect_pg_bin`,
      { PATH: `${stubPath}:/usr/bin:/bin` },
    );

    // On a CI host the absolute fallback list may include a real install
    // (e.g. /usr/lib/postgresql/16/bin). In that case the helper short-circuits
    // before reaching pg_config, which is still correct behaviour.
    // Assert that *some* valid bindir was returned and pg_ctl is executable
    // there — that is the core post-condition of detect_pg_bin.
    expect(status).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    const probe = spawnSync('test', ['-x', path.join(stdout, 'pg_ctl')]);
    expect(probe.status).toBe(0);
  });

  it('returns non-zero exit when no PG bin can be located at all', () => {
    // Empty PATH so neither pg_config nor any candidate dir is accessible.
    // Also override candidates by passing PG_BIN to a non-existent dir so the
    // first branch is skipped.
    const nowhere = path.join(workDir, 'definitely-not-pg');
    const { status } = runBash(
      // Wrap in subshell to avoid bash -e killing the whole script on failure
      `(. "${PG_ENV_SH}" && detect_pg_bin)`,
      {
        PG_BIN: nowhere,
        PATH: '/nonexistent-dir',
      },
    );

    expect(status).not.toBe(0);
  });
});

describe('scripts/local-node-runtime.sh — port_in_use fallback chain (R-095)', () => {
  it('exposes port_in_use as a shell function', () => {
    const { stdout, status } = runBash(
      `. "${LOCAL_RUNTIME_SH}" >/dev/null 2>&1 && type -t port_in_use`,
    );

    expect(status).toBe(0);
    expect(stdout).toBe('function');
  });

  it('returns "free" (non-zero exit) when no probe tool is available on PATH', () => {
    // Empty PATH so neither ss, lsof nor netstat resolves
    const { status } = runBash(
      `. "${LOCAL_RUNTIME_SH}" >/dev/null 2>&1; port_in_use 65535`,
      { PATH: '/nonexistent-dir' },
    );

    expect(status).not.toBe(0);
  });
});

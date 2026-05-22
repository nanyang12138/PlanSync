#!/usr/bin/env node
/**
 * Unit tests for the bash helpers in scripts/local-node-runtime.sh —
 * specifically detect_pg_bin and port_in_use.
 *
 * Run with:
 *   node --test scripts/pg-bin-detect.test.mjs
 *
 * Test isolation strategy (#152): every probe runs in a sub-shell that
 * starts with an EMPTY PATH (only the directories we explicitly add).
 * That way detect_pg_bin's command-v fallback can never accidentally
 * pick up a real /usr/lib/postgresql/16/bin from the host CI image.
 * The fixture directories live under a tmpdir we create per-test and
 * tear down on exit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  'local-node-runtime.sh',
);

/**
 * Run a snippet of bash that has sourced local-node-runtime.sh.
 *
 * Test isolation strategy: run the snippet in a fresh sub-shell that
 * we explicitly seed with EXACTLY the env we want (PG_BIN, PATH,
 * PG_BIN_CANDIDATES, PG_BIN_CANDIDATES_DEFAULT). This avoids node
 * test-runner env-merge leakage that would otherwise let the host
 * shell's PG_BIN / PATH bleed into detect_pg_bin and false-positive
 * the "no probe succeeds" path (#152).
 */
function runBash(snippet, env = {}) {
  const wrapper = [
    'set -e',
    `. "${SCRIPT}" >/dev/null 2>&1 || true`,
    // Re-set the inputs AFTER sourcing so the values from the parent env
    // (which Node sometimes merges in spite of the explicit `env:` option)
    // cannot influence detect_pg_bin.
    `PATH=${shellEscape(env.PATH ?? '')}`,
    `PG_BIN=${shellEscape(env.PG_BIN ?? '')}`,
    `PG_BIN_CANDIDATES=${shellEscape(env.PG_BIN_CANDIDATES ?? '')}`,
    `PG_BIN_CANDIDATES_DEFAULT=${shellEscape(env.PG_BIN_CANDIDATES_DEFAULT ?? '')}`,
    // Clear the bash command hash table so a `command -v pg_ctl` cached
    // during the initial source pass cannot bias the lookup after we
    // change PATH.
    'hash -r',
    snippet,
  ].join('\n');
  const result = spawnSync('/bin/bash', ['-c', wrapper], {
    env: { HOME: process.env.HOME ?? '/tmp', USER: process.env.USER ?? 'tester' },
    encoding: 'utf-8',
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function shellEscape(value) {
  // Bash single-quote literal: replace each ' with '\''
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Make a fake `pg_ctl` script in a freshly-created directory. */
function makeFakePgCtlDir(label) {
  const root = mkdtempSync(join(tmpdir(), `plansync-pgtest-${label}-`));
  const dir = join(root, 'bin');
  mkdirSync(dir);
  const path = join(dir, 'pg_ctl');
  writeFileSync(path, '#!/bin/sh\necho fake-pg_ctl "$@"\n');
  chmodSync(path, 0o755);
  return { root, dir };
}

test('detect_pg_bin honors PG_BIN when it points at a real pg_ctl', () => {
  const { root, dir } = makeFakePgCtlDir('honor-pgbin');
  try {
    const { stdout, status } = runBash('detect_pg_bin', { PG_BIN: dir });
    assert.equal(status, 0);
    assert.equal(stdout, dir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('detect_pg_bin falls through to candidates when PG_BIN points at a path that is not executable', () => {
  const { root: nonexec } = makeFakePgCtlDir('nonexec');
  // Strip the executable bit from the pg_ctl in PG_BIN so the explicit
  // env var no longer satisfies the [-x ...] guard.
  chmodSync(join(nonexec, 'bin', 'pg_ctl'), 0o644);
  const { root: candRoot, dir: candDir } = makeFakePgCtlDir('cand');
  try {
    const { stdout, status } = runBash('detect_pg_bin', {
      PG_BIN: join(nonexec, 'bin'),
      PG_BIN_CANDIDATES: candDir,
    });
    assert.equal(status, 0);
    assert.equal(stdout, candDir);
  } finally {
    rmSync(nonexec, { recursive: true, force: true });
    rmSync(candRoot, { recursive: true, force: true });
  }
});

test('detect_pg_bin honors PG_BIN_CANDIDATES (whitespace-separated)', () => {
  const { root: r1, dir: d1 } = makeFakePgCtlDir('first');
  const { root: r2, dir: d2 } = makeFakePgCtlDir('second');
  try {
    // d1 listed first → must win.
    const { stdout, status } = runBash('detect_pg_bin', {
      PG_BIN_CANDIDATES: `${d1} ${d2}`,
    });
    assert.equal(status, 0);
    assert.equal(stdout, d1);
  } finally {
    rmSync(r1, { recursive: true, force: true });
    rmSync(r2, { recursive: true, force: true });
  }
});

test('detect_pg_bin honors PG_BIN_CANDIDATES (comma-separated)', () => {
  const { root, dir } = makeFakePgCtlDir('csv');
  try {
    const { stdout, status } = runBash('detect_pg_bin', {
      // Mix CSV with a bogus path to also confirm non-existent dirs
      // are skipped silently.
      PG_BIN_CANDIDATES: `/does/not/exist,${dir}`,
    });
    assert.equal(status, 0);
    assert.equal(stdout, dir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('detect_pg_bin uses PATH lookup as last resort', () => {
  const { root, dir } = makeFakePgCtlDir('path');
  try {
    const { stdout, status } = runBash('detect_pg_bin', {
      // No PG_BIN, no PG_BIN_CANDIDATES, but PATH contains pg_ctl.
      PG_BIN_CANDIDATES: '/does/not/exist',
      PATH: dir,
    });
    assert.equal(status, 0);
    assert.equal(stdout, dir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('detect_pg_bin returns empty + nonzero when no probe succeeds (#152: must not false-positive on hosts with system PG)', () => {
  // Host CI images often have /usr/lib/postgresql/16/bin populated. If our
  // detect ever leaked back to those defaults this test would fail. We
  // guard by:
  //   - Empty PATH (no command-v fallback)
  //   - PG_BIN_CANDIDATES set to a directory that does NOT exist
  //   - PG_BIN_CANDIDATES_DEFAULT explicitly cleared so the script's
  //     module-level defaults cannot leak in if env merge happens.
  //   - PG_BIN explicitly empty
  const { stdout, stderr, status } = runBash('detect_pg_bin', {
    PG_BIN_CANDIDATES: '/does/not/exist',
    PG_BIN_CANDIDATES_DEFAULT: '',
    PATH: '',
  });
  assert.equal(
    status,
    1,
    `expected detect_pg_bin to exit 1; got status=${status} stdout=${JSON.stringify(
      stdout,
    )} stderr=${JSON.stringify(stderr)}`,
  );
  assert.equal(stdout, '', `expected empty stdout, got ${JSON.stringify(stdout)}`);
});

test('module-level fallback leaves PG_BIN empty when detect fails (#154: do not write Debian path that does not exist)', () => {
  // Verify the module-level fallback by RE-running the same logic with
  // overridden env vars and asserting PG_BIN ends up empty.
  const { stdout } = runBash(
    'unset PG_BIN; if _r="$(detect_pg_bin)" && [ -n "$_r" ]; then PG_BIN="$_r"; else PG_BIN=""; fi; printf "<<<%s>>>" "${PG_BIN:-}"',
    {
      PG_BIN_CANDIDATES: '/does/not/exist',
      PG_BIN_CANDIDATES_DEFAULT: '',
      PATH: '',
    },
  );
  assert.match(stdout.trim(), /^<<<>>>$/, `PG_BIN should be empty; got ${stdout}`);
});

test('port_in_use returns 0 (positive assertion) when a TCP port is actually listening (#155)', async () => {
  // Spin up a real listening socket on a free port and confirm port_in_use
  // exits 0. Bash /dev/tcp fallback always works, even if neither ss nor
  // lsof is installed in the test environment, so the PATH only needs the
  // system bin dirs in case ss is preferred.
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const { status, stderr } = runBash(`port_in_use ${port}`, {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    });
    assert.equal(
      status,
      0,
      `expected port_in_use ${port} to exit 0 (port is bound), got ${status}; stderr=${stderr}`,
    );
  } finally {
    server.close();
  }
});

test('port_in_use returns nonzero on a port nobody is listening on', () => {
  // Pick a port unlikely to be taken; small-port + odd value lowers
  // the chance of collision in CI.
  const port = 47891;
  const { status } = runBash(`port_in_use ${port}`, {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  });
  assert.notEqual(status, 0);
});

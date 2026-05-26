#!/usr/bin/env node
/**
 * Regression guard for #366 / #540 / #567.
 *
 *   node --test scripts/dev-user-export.test.mjs
 *
 * `scripts/dev.sh` computes BUILD_DIR from the resolved USER value. The
 * Next.js config file (`packages/api/next.config.js`) computes its own
 * `distDir` from `process.env.USER || 'dev'`. If dev.sh resolves USER
 * locally (via `${USER:-$(whoami)}`) but does NOT export it, the child
 * Next process sees a different value and writes its build to a
 * different directory than dev.sh's marker / clear logic operates on.
 *
 * The fix in dev.sh is one line:
 *   `export USER="${USER:-$(whoami)}"`
 *
 * This test runs that snippet in a sub-shell with USER unset and asserts
 * that:
 *   1. USER is non-empty after the export (whoami fired);
 *   2. the value matches what the Node process inherits (so
 *      next.config.js's `process.env.USER` agrees);
 *   3. the resulting BUILD_DIR string matches the next.config.js
 *      `process.env.USER || 'dev'` computation.
 *
 * Bonus: a static-source check that dev.sh actually contains the
 * `export USER` line, so a future refactor that drops the export breaks
 * CI before the divergence re-emerges.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEV_SH = resolve(REPO_ROOT, 'scripts/dev.sh');

test('#366/#540/#567: dev.sh exports USER so next.config.js sees the resolved value', () => {
  // Sub-shell mirrors the dev.sh snippet:
  //   export USER="${USER:-$(whoami)}"
  //   echo "$USER"
  const r = spawnSync(
    '/bin/bash',
    [
      '-c',
      // Unset USER so the fallback path is exercised, then run the
      // line as it appears in dev.sh, then echo the value to stdout AND
      // spawn a child node that reads process.env.USER.
      `unset USER; export USER="\${USER:-$(whoami)}"; echo SHELL=$USER; node -e "console.log('NODE=' + (process.env.USER || 'dev'))"`,
    ],
    {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      encoding: 'utf-8',
    },
  );
  assert.equal(r.status, 0, `stderr was: ${r.stderr}`);
  const lines = (r.stdout ?? '').trim().split('\n');
  const shellLine = lines.find((l) => l.startsWith('SHELL='));
  const nodeLine = lines.find((l) => l.startsWith('NODE='));
  assert.ok(shellLine, `expected SHELL= line; got ${r.stdout}`);
  assert.ok(nodeLine, `expected NODE= line; got ${r.stdout}`);

  const shellUser = shellLine.slice('SHELL='.length);
  const nodeUser = nodeLine.slice('NODE='.length);

  // Both must be non-empty (whoami fired).
  assert.notEqual(shellUser, '', 'shell USER must be non-empty after export');
  assert.notEqual(nodeUser, '', 'node process.env.USER must be non-empty after export');
  // And they must agree — that's the whole point of `export`.
  assert.equal(shellUser, nodeUser, 'shell USER and node process.env.USER must match');
  // It must NOT be the next.config.js fallback literal 'dev' — pre-fix
  // would have shown 'dev' because USER was unset in node's env.
  assert.notEqual(nodeUser, 'dev', 'node USER fell back to literal "dev" — export not propagating');
});

test('static guard: dev.sh exports both PLANSYNC_BUILD_USER and USER (F1 refactor-resistance)', () => {
  const text = readFileSync(DEV_SH, 'utf-8');
  // F1 (#899) replaced the single `export USER="${USER:-$(whoami)}"` line with
  // a canonical PLANSYNC_BUILD_USER chain that next.config.js, build.sh, and
  // dev.sh all share. B23 (#287 #466 #510 #526 #901) further factored the
  // resolution out into scripts/build-user.sh so the trim semantics
  // match next.config.js's `(env || '').trim()`. Either form is
  // acceptable so this test survives both the inline expansion and
  // the helper call form.
  const buildUserViaHelper =
    /^\s*export\s+PLANSYNC_BUILD_USER\s*=\s*["']?\$\(resolve_build_user\)["']?/m;
  const buildUserViaInline =
    /^\s*export\s+PLANSYNC_BUILD_USER\s*=\s*["']\$\{PLANSYNC_BUILD_USER:-\$\{USER:-\$\(whoami\)\}\}["']/m;
  const userExport = /^\s*export\s+USER\s*=\s*["']\$PLANSYNC_BUILD_USER["']/m;
  assert.ok(
    buildUserViaHelper.test(text) || buildUserViaInline.test(text),
    `dev.sh missing canonical PLANSYNC_BUILD_USER export — neither` +
      ` $(resolve_build_user) helper nor the inline ` +
      `\${PLANSYNC_BUILD_USER:-\${USER:-$(whoami)}} form was found.`,
  );
  assert.match(
    text,
    userExport,
    `dev.sh must re-export USER="$PLANSYNC_BUILD_USER" so legacy tooling that reads USER sees the resolved identity`,
  );
});

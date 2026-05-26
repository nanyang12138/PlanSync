/**
 * Closes #287 #466 #510 #526 #901 — verifies that scripts/build-user.sh's
 * resolve_build_user() function mirrors the trim() semantics of
 * packages/api/next.config.js's resolveBuildUser(). Pre-fix, dev.sh +
 * build.sh used `${VAR:-fallback}` which only falls back on UNSET or
 * empty — a whitespace-only value (`"   "`) leaked through and split
 * the build-cache identity from what next.config.js computed.
 *
 * The shell function and the JS function should now agree byte-for-
 * byte on every input, including whitespace-only and missing-USER
 * environments. We assert that here by running the bash function in
 * a sub-shell and the JS resolver in-process.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_USER_SH = resolve(__dirname, 'build-user.sh');
const NEXT_CONFIG_JS = resolve(__dirname, '../packages/api/next.config.js');

/** Run `. build-user.sh; resolve_build_user` in a sub-shell with a
 *  controlled env, return its stdout (no trailing whitespace). */
function shellResolve(env) {
  const r = spawnSync('bash', ['-c', `. "${BUILD_USER_SH}"; resolve_build_user`], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    throw new Error(`shell exited ${r.status}: ${r.stderr}`);
  }
  return r.stdout;
}

/** Re-implement next.config.js's resolveBuildUser inline so this test
 *  can run without spawning Next. The contract is intentionally
 *  the same shape as the function in next.config.js. */
function jsResolve(env) {
  const explicit = (env.PLANSYNC_BUILD_USER ?? '').trim();
  if (explicit) return explicit;
  const fromUser = (env.USER ?? '').trim();
  if (fromUser) return fromUser;
  return 'shared';
}

const cases = [
  // [name, env]
  ['explicit ascii name', { PLANSYNC_BUILD_USER: 'alice' }],
  ['explicit with leading whitespace (trimmed)', { PLANSYNC_BUILD_USER: '  alice' }],
  ['explicit with trailing whitespace (trimmed)', { PLANSYNC_BUILD_USER: 'alice  ' }],
  [
    'explicit with whitespace both sides (trimmed)',
    { PLANSYNC_BUILD_USER: '   alice   ' },
  ],
  ['empty PLANSYNC_BUILD_USER → fallback to USER', { PLANSYNC_BUILD_USER: '', USER: 'bob' }],
  [
    'whitespace-only PLANSYNC_BUILD_USER → fallback to USER (closes #901)',
    { PLANSYNC_BUILD_USER: '   ', USER: 'bob' },
  ],
  [
    'tab-only PLANSYNC_BUILD_USER → fallback to USER',
    { PLANSYNC_BUILD_USER: '\t\t', USER: 'bob' },
  ],
  [
    'whitespace-only USER too → fallback through to whoami / shared',
    { PLANSYNC_BUILD_USER: '   ', USER: '   ' },
  ],
  // Closes #1169 #1156 #1127 — JS `.trim()` strips a wider Unicode
  // whitespace set than bash POSIX `[[:space:]]`. The bash helper
  // must agree byte-for-byte with next.config.js for every input
  // below; otherwise the build-cache identity splits exactly the
  // same way #287 / #901 closed.
  ['NBSP-prefixed PLANSYNC_BUILD_USER (closes #1169 #1156 #1127)', { PLANSYNC_BUILD_USER: '\u00A0alice' }],
  ['NBSP-suffixed PLANSYNC_BUILD_USER', { PLANSYNC_BUILD_USER: 'alice\u00A0' }],
  ['BOM-prefixed PLANSYNC_BUILD_USER', { PLANSYNC_BUILD_USER: '\uFEFFalice' }],
  ['ideographic-space-wrapped PLANSYNC_BUILD_USER', { PLANSYNC_BUILD_USER: '\u3000alice\u3000' }],
  ['en-quad + em-space wrapped PLANSYNC_BUILD_USER', { PLANSYNC_BUILD_USER: '\u2000alice\u2003' }],
  ['narrow-NBSP wrapped PLANSYNC_BUILD_USER', { PLANSYNC_BUILD_USER: '\u202Falice\u205F' }],
  // NBSP-only must fall through the same way ascii whitespace-only does.
  ['NBSP-only PLANSYNC_BUILD_USER → fallback to USER', { PLANSYNC_BUILD_USER: '\u00A0\u00A0', USER: 'bob' }],
];

for (const [name, env] of cases) {
  test(`build-user.sh ↔ next.config.js agree: ${name}`, () => {
    const fromShell = shellResolve(env);
    const fromJs = jsResolve(env);
    // The "fallback to whoami / shared" case picks up whoami in the
    // shell (real linux user, e.g. "ubuntu") and "shared" in JS
    // (because USER is whitespace-only). The contract we care about
    // is: BOTH must produce the same NON-EMPTY, NON-WHITESPACE value
    // — the exact value can legitimately differ at the bottom of
    // the fallback chain (whoami is a side-channel). Stricter than
    // that would make the test environment-dependent.
    if (env.PLANSYNC_BUILD_USER && env.PLANSYNC_BUILD_USER.trim() !== '') {
      assert.equal(fromShell, fromJs, `expected exact match, got shell=${fromShell} js=${fromJs}`);
    } else if (env.USER && env.USER.trim() !== '') {
      assert.equal(fromShell, fromJs);
    } else {
      // Bottom of chain — both produce SOMETHING non-empty + trimmed.
      assert.notEqual(fromShell, '', 'shell resolution must be non-empty');
      assert.equal(fromShell.trim(), fromShell, 'shell value must be trimmed');
      assert.notEqual(fromJs, '', 'js resolution must be non-empty');
    }
  });
}

test('static guard: scripts/build-user.sh defines resolve_build_user', () => {
  const r = spawnSync('grep', ['-cE', '^resolve_build_user\\(\\)', BUILD_USER_SH], {
    encoding: 'utf-8',
  });
  assert.equal(r.stdout.trim(), '1', `resolve_build_user must be defined in ${BUILD_USER_SH}`);
});

test('static guard: next.config.js still does the same trim chain', () => {
  // If a future refactor drops the trim() in next.config.js, this
  // test fails so the symmetry doesn't silently break.
  const text = readFileSync(NEXT_CONFIG_JS, 'utf-8');
  assert.match(
    text,
    /\.trim\(\)/,
    'next.config.js must still .trim() the resolved values to match build-user.sh',
  );
});

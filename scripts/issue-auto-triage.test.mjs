/**
 * Unit tests for scripts/issue-auto-triage.mjs's pure helpers.
 *
 * We can't reach into the script's runtime (it spawns `gh` at import
 * time when env is set), so the helpers under test are mirrored
 * inline. The static-source guard at the bottom asserts the canonical
 * source still defines the same names so a future refactor that
 * drops them fails this test.
 *
 * History note (issue #2750): this file was previously corrupted
 * by three back-to-back PRs (#1463 / #1443 / #1441) that were each
 * resolved with bad three-way merges, leaving stacked duplicate
 * `parseLimitEnv` definitions, duplicate `const trimmed` / `const
 * parsed` bindings, and an unterminated `assert.doesNotMatch(` call.
 * `node --check` failed with `SyntaxError: missing ) after argument
 * list` at line 201 so every test in the file silently went unrun.
 *
 * Repair strategy: collapse to a single canonical `parseLimitEnv`
 * mirror whose behavior matches the production helper in
 * `scripts/issue-auto-triage.mjs` (strict `/^\d+$/` validation with
 * fallback-to-default for every garbage shape, including negatives).
 * Every anti-regression test from the historical PRs (#1234 NaN,
 * #1239 NaN, #1328 prefix-garbage, #1347 partial-numeric, #1379
 * prefix/decimal/exponent, #1397 numeric-prefix garbage) is preserved
 * exactly once. PR #1441's clamp-negatives-to-zero policy lives in
 * production-side PR #2764 (in flight) and a follow-up will sync the
 * mirror once that lands — repairing the test file is intentionally
 * scoped to "make it parse + restore the existing contract" and does
 * not smuggle a behavior change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT_PATH = resolve(import.meta.dirname, 'issue-auto-triage.mjs');

// Mirror of the regex in scripts/issue-auto-triage.mjs. Pre-fix,
// find-pending-must.sh used a stricter form that missed the singular
// `fix #N` and `closed #N` variants; those are now covered.
const CLOSING_KEYWORD_RE = /\b(?:close[ds]?|fix(?:e[sd])?|resolve[ds]?)\s*[:#]?\s*#(\d+)\b/gi;

function extractClosesRefs(body, title) {
  const refs = new Set();
  const haystack = `${body || ''} ${title || ''}`;
  for (const m of haystack.matchAll(CLOSING_KEYWORD_RE)) {
    refs.add(Number.parseInt(m[1], 10));
  }
  return refs;
}

test('extractClosesRefs picks up every closing-keyword variant', () => {
  const body = `
Body text.

## Closes
- closes #1
- Closes #2
- close #3
- closed #4
- fix #5
- fixes #6
- fixed #7
- resolve #8
- resolves #9
- resolved #10
Closes: #11
`;
  const refs = extractClosesRefs(body, 'fixes #12');
  assert.deepEqual(
    [...refs].sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
});

test('extractClosesRefs ignores non-keyword issue references', () => {
  // Pre-fix the simpler regex matched any `#N`, which silently
  // skipped issues mentioned conversationally (e.g. "see #99").
  const body = 'See also #99 and #100. Related: #101.';
  const refs = extractClosesRefs(body, '');
  assert.equal(refs.size, 0);
});

test('extractClosesRefs handles markdown-bold around the keyword', () => {
  // The original GitHub parser ignores `**closes #1**` but our regex
  // currently picks it up anyway. We document the current behaviour:
  // we are intentionally more permissive so that PRs which got their
  // closes auto-close *missed* by GitHub (due to markdown) are still
  // closed by this script.
  const body = '**closes #42**';
  const refs = extractClosesRefs(body, '');
  assert.deepEqual([...refs], [42]);
});

test('extractClosesRefs is null/undefined safe', () => {
  assert.equal(extractClosesRefs(null, null).size, 0);
  assert.equal(extractClosesRefs(undefined, undefined).size, 0);
  assert.equal(extractClosesRefs('', '').size, 0);
});

test('static guard: issue-auto-triage.mjs still defines the canonical helpers', () => {
  const src = readFileSync(SCRIPT_PATH, 'utf-8');
  assert.match(src, /const CLOSING_KEYWORD_RE\s*=/);
  assert.match(src, /function extractClosesRefs\s*\(/);
  assert.match(src, /function categorize\s*\(/);
  assert.match(src, /const PROBES\s*=/);
  assert.match(src, /const SKIP_LABELS\s*=/);
  // The four action verdicts must remain stable — they are the public
  // contract of the script (used in the workflow log + audit comments).
  assert.match(src, /resolved-by-pr/);
  assert.match(src, /resolved-in-tree/);
  assert.match(src, /phantom/);
  assert.match(src, /dispatch/);
});

test('static guard: cursor:dispatch is added with triggersDownstreamWorkflow=true (closes the GITHUB_TOKEN recursion-guard footgun)', () => {
  // Production hit on 2026-05-26: the script added cursor:dispatch
  // labels successfully with GITHUB_TOKEN, but GitHub silently
  // suppressed the resulting `issues: labeled` event so
  // cursor-review-dispatch.yml never spawned an agent. Fix: route
  // the dispatch label add through ghAsUser() (CURSOR_REVIEW_PAT)
  // by passing triggersDownstreamWorkflow=true. This guard fails
  // if a future refactor drops the flag.
  const src = readFileSync(SCRIPT_PATH, 'utf-8');
  assert.match(src, /function ghAsUser\s*\(/);
  // dispatchIssue must call addLabelsToIssue with the trigger flag.
  // We match the multi-line call shape (prettier may wrap).
  const dispatchCallRe =
    /addLabelsToIssue\([^)]*'cursor:dispatch'[\s\S]*?triggersDownstreamWorkflow:\s*true/m;
  assert.ok(
    dispatchCallRe.test(src),
    'dispatchIssue must call addLabelsToIssue with triggersDownstreamWorkflow:true — without it, GitHub drops the labeled event and the downstream agent dispatch never fires.',
  );
});

test('static guard: every label used in actions is bootstrapped via ensureRequiredLabels', () => {
  // Crash on 2026-05-26 was "'auto-triaged' not found" — the script
  // tried to apply a label that did not exist in the repo, gh
  // returned non-zero, and the whole batch died after closing only
  // one issue (#1219). The fix is REQUIRED_LABELS at startup +
  // best-effort label adds. This guard makes sure a future refactor
  // does not silently drop either piece.
  const src = readFileSync(SCRIPT_PATH, 'utf-8');
  assert.match(src, /const REQUIRED_LABELS\s*=/);
  assert.match(src, /function ensureRequiredLabels\s*\(/);
  assert.match(src, /function addLabelsToIssue\s*\(/);
  for (const label of ['auto-triaged', 'needs-human', 'cursor:dispatch', 'dispatched']) {
    assert.ok(
      src.includes(`name: '${label}'`),
      `REQUIRED_LABELS must include '${label}' so the script bootstraps it on first run`,
    );
  }
  // There must be exactly ONE `'issue', 'edit', ..., '--add-label'`
  // shell-call shape in the source — the chokepoint inside
  // addLabelsToIssue(). Any additional occurrence would mean
  // commentAndClose / dispatchIssue started bypassing the
  // best-effort wrapper, re-introducing the 2026-05-26 crash mode.
  // We deliberately match the args-array rather than the helper
  // name (gh / ghAsUser) so the guard survives the trigger-token
  // refactor: whatever runner the wrapper picks, the actual gh
  // CLI invocation lives in exactly one place.
  const editAddLabelRe = /\[\s*'issue',\s*'edit'[\s\S]*?'--add-label'/gm;
  const editAddLabelCalls = src.match(editAddLabelRe) || [];
  assert.equal(
    editAddLabelCalls.length,
    1,
    `expected exactly one 'gh issue edit ... --add-label' shell-call (inside addLabelsToIssue) but found ${editAddLabelCalls.length}. ` +
      `commentAndClose / dispatchIssue must route label writes through addLabelsToIssue() so a missing label degrades to a warning.`,
  );
});

test('static guard: skip-label list covers every label that should freeze triage', () => {
  const src = readFileSync(SCRIPT_PATH, 'utf-8');
  for (const label of [
    'cursor:dispatch',
    'dispatched',
    'umbrella',
    'wontfix',
    'auto-triaged',
    'needs-human',
    'do-not-merge',
  ]) {
    assert.ok(
      src.includes(`'${label}'`),
      `SKIP_LABELS must include '${label}' (defensive against re-dispatch loops)`,
    );
  }
});

// Mirror of parseLimitEnv() in scripts/issue-auto-triage.mjs. Kept
// inline so the test can exercise the helper without importing the
// script (which spawns `gh` at module load when env is set). The
// static-source guard below asserts the canonical implementation
// still exists.
//
// Contract (matches the production helper line-for-line):
//   - undefined / null / empty string / whitespace-only  → default, silent
//   - trimmed string that is NOT exactly `/^\d+$/`        → default + warn
//     (catches NaN-shape garbage like 'abc', numeric-prefix garbage
//     like '5abc', decimals '3.5', scientific '1e2', hex '0x10',
//     signed '+5' / '-5', and any other parseInt-permissive shape
//     that previously silently changed the rate-limit value — the
//     #1239 / #1328 / #1347 / #1379 / #1397 findings).
//   - non-negative integer string                         → parsed
//
// The doubled `|| parsed < 0` guard at the bottom is dead code given
// the strict `/^\d+$/` pre-filter, but production keeps it as belt-
// and-braces in case a future refactor loosens the regex; the mirror
// keeps it too so the static guard finds a comparable shape on both
// sides.
function parseLimitEnv(name, raw, defaultValue, warn = () => {}) {
  if (raw === undefined || raw === null) {
    return defaultValue;
  }
  const trimmed = typeof raw === 'string' ? raw.trim() : String(raw);
  if (trimmed === '') {
    return defaultValue;
  }
  const parsed = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    warn(
      `[triage] ${name}=${JSON.stringify(raw)} is not a non-negative integer; ` +
        `falling back to default=${defaultValue} to preserve rate-limit semantics.`,
    );
    return defaultValue;
  }
  return parsed;
}

test('parseLimitEnv returns default when env var is unset / empty', () => {
  assert.equal(parseLimitEnv('X', undefined, 3), 3);
  assert.equal(parseLimitEnv('X', null, 3), 3);
  assert.equal(parseLimitEnv('X', '', 3), 3);
});

test('parseLimitEnv treats whitespace-only input as empty (default fallback, no warning)', () => {
  // '   ' is morally the same as '' — empty input means "I did not
  // configure this knob", not "I configured it to garbage". Take
  // the default silently; reserve the warning for actively bad input.
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  assert.equal(parseLimitEnv('X', '   ', 3, warn), 3);
  assert.equal(parseLimitEnv('X', '\n', 3, warn), 3);
  assert.equal(parseLimitEnv('X', '\t', 3, warn), 3);
  assert.equal(warnings.length, 0);
});

test('parseLimitEnv parses valid non-negative integers', () => {
  assert.equal(parseLimitEnv('X', '0', 3), 0);
  assert.equal(parseLimitEnv('X', '5', 3), 5);
  assert.equal(parseLimitEnv('X', '25', 3), 25);
});

test('parseLimitEnv trims surrounding whitespace (heredoc / shell-export quirks)', () => {
  // `'5\n'` from a heredoc, `' 5 '` from a copy-paste — both should
  // still mean 5. The trim happens BEFORE strict-integer validation
  // so the user-facing behaviour is "whitespace doesn't matter".
  assert.equal(parseLimitEnv('X', '5\n', 3), 5);
  assert.equal(parseLimitEnv('X', '  5  ', 3), 5);
  assert.equal(parseLimitEnv('X', '\t10\t', 3), 10);
});

test('parseLimitEnv falls back to default on NaN input (the rate-limit-bypass bug — #1234 / #1239)', () => {
  // workflow_dispatch input "abc" would produce NaN, and
  // `count >= NaN` is always false, so the loop never breaks and the
  // entire backlog gets dispatched/closed.
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  assert.equal(parseLimitEnv('TRIAGE_MAX_DISPATCH', 'abc', 3, warn), 3);
  assert.equal(parseLimitEnv('TRIAGE_MAX_CLOSE', 'not-a-number', 25, warn), 25);
  assert.equal(parseLimitEnv('X', 'unlimited', 3, warn), 3);
  assert.equal(parseLimitEnv('X', 'NaN', 3, warn), 3);
  assert.equal(warnings.length, 4);
  // The warning must name the offending env var so a CI log
  // skim-reader can spot the misconfigured workflow_dispatch input.
  assert.match(warnings[0], /TRIAGE_MAX_DISPATCH/);
  assert.match(warnings[1], /TRIAGE_MAX_CLOSE/);
});

test('parseLimitEnv falls back to default on negative integers', () => {
  // `-1 >= 0` is false, so a negative limit would otherwise disable
  // the rate-limit on the first loop iteration. The strict `/^\d+$/`
  // pre-filter rejects the leading `-` so '-1' lands in the
  // not-an-integer fallback alongside other garbage shapes. (PR
  // #2764 is reworking this to clamp-to-zero in production; a
  // follow-up will update the mirror to match once that lands.)
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  assert.equal(parseLimitEnv('TRIAGE_MAX_DISPATCH', '-1', 3, warn), 3);
  assert.equal(parseLimitEnv('TRIAGE_MAX_CLOSE', '-100', 25, warn), 25);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /TRIAGE_MAX_DISPATCH/);
  assert.match(warnings[1], /TRIAGE_MAX_CLOSE/);
});

test('parseLimitEnv rejects numeric-prefix garbage (#1328 / #1347 / #1397)', () => {
  // Pre-fix, Number.parseInt('5abc', 10) returned 5 — silently
  // truncating a user typo to a number that "happens to work".
  // The documented contract is "invalid input falls back to
  // default"; numeric-prefix garbage must take the fallback path
  // and emit a warning, identical to the full-garbage / NaN case.
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  assert.equal(parseLimitEnv('TRIAGE_MAX_DISPATCH', '5abc', 3, warn), 3);
  assert.equal(parseLimitEnv('TRIAGE_MAX_CLOSE', '25xyz', 25, warn), 25);
  assert.equal(parseLimitEnv('X', '100abc', 3, warn), 3);
  assert.equal(parseLimitEnv('X', '3 4', 7, warn), 7);
  assert.equal(parseLimitEnv('X', '3 ; rm -rf /', 7, warn), 7);
  assert.equal(warnings.length, 5);
  // Every warning must name the offending env var so a CI log
  // skim-reader can spot the misconfigured workflow_dispatch input.
  assert.match(warnings[0], /TRIAGE_MAX_DISPATCH/);
  assert.match(warnings[1], /TRIAGE_MAX_CLOSE/);
});

test('parseLimitEnv rejects prefix-numbers / decimals / exponents / hex / signed (#1379)', () => {
  // Number.parseInt is prefix-permissive, so the original
  // implementation accepted '999abc' → 999, '3.5' → 3, '1e2' → 1.
  // That silently AMPLIFIES the rate-limit on garbage input (a
  // workflow_dispatch typo like max_dispatch='999abc' would dispatch
  // 999 issues in a single run). Reject every parseInt-quirk shape
  // and fall back to the default instead.
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  for (const raw of [
    '999abc', // prefix-number   → parseInt returns 999
    '3.5', // decimal           → parseInt returns 3
    '5.0', // even integer-valued decimal must still be rejected
    '1e2', // scientific        → parseInt returns 1
    '0x10', // hex              → parseInt returns 0 (radix=10)
    '0xA', // hex               → parseInt returns 0 (radix=10)
    '+5', // signed positive   → parseInt returns 5; reject for strictness
    '--5', // double-negative  → parseInt returns NaN; reject loudly
  ]) {
    assert.equal(
      parseLimitEnv('TRIAGE_MAX_DISPATCH', raw, 3, warn),
      3,
      `raw=${JSON.stringify(raw)} must fall back to default, not silently parse as a number`,
    );
  }
  assert.equal(warnings.length, 8);
  for (const msg of warnings) {
    assert.match(msg, /TRIAGE_MAX_DISPATCH/);
  }
});

test('parseLimitEnv: rate-limit comparison is sound for every fallback path', () => {
  // End-to-end shape of the bug: simulate the loop break with the
  // value parseLimitEnv returns. count is 0 at the start of the
  // loop; `0 >= LIMIT` must be a real boolean (never NaN-poisoned)
  // so the loop terminates after at most LIMIT iterations.
  for (const raw of [
    'abc',
    '',
    undefined,
    null,
    '-5',
    'NaN',
    '5abc',
    '999abc',
    '3.5',
    '1e2',
    '0x10',
    '+5',
    '   ',
  ]) {
    const limit = parseLimitEnv('X', raw, 3);
    assert.equal(typeof limit, 'number');
    assert.ok(Number.isFinite(limit), `limit must be finite for raw=${JSON.stringify(raw)}`);
    assert.ok(limit >= 0, `limit must be non-negative for raw=${JSON.stringify(raw)}`);
  }
});

test('static guard: issue-auto-triage.mjs still defines parseLimitEnv and uses it for both knobs', () => {
  // If a future refactor inlines `Number.parseInt(... || '3', 10)`
  // again, the rate-limit-bypass bug returns. Pin the helper.
  const src = readFileSync(SCRIPT_PATH, 'utf-8');
  assert.match(src, /function parseLimitEnv\s*\(/);
  assert.match(
    src,
    /MAX_DISPATCH\s*=\s*parseLimitEnv\(\s*'TRIAGE_MAX_DISPATCH'/,
    'MAX_DISPATCH must go through parseLimitEnv to reject NaN/negative',
  );
  assert.match(
    src,
    /MAX_CLOSE\s*=\s*parseLimitEnv\(\s*'TRIAGE_MAX_CLOSE'/,
    'MAX_CLOSE must go through parseLimitEnv to reject NaN/negative',
  );
  // Strict digits-only validation must remain in parseLimitEnv —
  // without it, Number.parseInt('5abc', 10) silently returns 5 and
  // the documented "invalid input → default" contract is broken
  // again (the #1328 / #1347 / #1379 / #1397 findings).
  assert.match(
    src,
    /\/\^\\d\+\$\//,
    'parseLimitEnv must validate the trimmed string with /^\\d+$/ — bare Number.parseInt is prefix-permissive and silently amplifies rate limits on garbage input',
  );
  // The MAX_* env vars must be routed through the helper. A future
  // refactor that re-introduces bare `Number.parseInt(process.env.TRIAGE_MAX_*`
  // would resurrect the #1234 / #1239 / #1328 findings.
  assert.doesNotMatch(
    src,
    /Number\.parseInt\(\s*process\.env\.TRIAGE_MAX_/,
    'TRIAGE_MAX_* must not be parsed with bare Number.parseInt — that resurrects the rate-limit-bypass bug',
  );
});

test('static guard: ENOBUFS protection on gh wrapper (no silent stdout truncation)', () => {
  // Production hit on 2026-05-26: gh issue list returned ~1.1 MB of
  // JSON when the backlog grew past 800 issues, blowing past
  // spawnSync's default 1 MiB maxBuffer and silently truncating
  // stdout. We raised the cap to 64 MiB and started surfacing
  // r.error explicitly. This guard fails if either piece regresses.
  const src = readFileSync(SCRIPT_PATH, 'utf-8');
  assert.match(
    src,
    /maxBuffer:\s*GH_MAX_BUFFER/,
    'gh wrapper must pass maxBuffer:GH_MAX_BUFFER to spawnSync — default 1 MiB cap silently truncates large gh JSON',
  );
  assert.match(
    src,
    /if\s*\(\s*r\.error\b/,
    'gh wrapper must surface r.error so ENOBUFS / ENOENT / signal kills become thrown errors instead of silent truncation',
  );
});

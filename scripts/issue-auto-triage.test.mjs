/**
 * Unit tests for scripts/issue-auto-triage.mjs's pure helpers.
 *
 * We can't reach into the script's runtime (it spawns `gh` at import
 * time when env is set), so the helpers under test are mirrored
 * inline. The static-source guard at the bottom asserts the canonical
 * source still defines the same names so a future refactor that
 * drops them fails this test.
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

// Mirror of parseLimitEnv from scripts/issue-auto-triage.mjs. Tested
// in isolation because importing the script triggers top-level `gh`
// calls. The static guard further down asserts the canonical source
// stays in sync with this mirror.
function parseLimitEnv(name, raw, defaultValue) {
  if (raw === undefined || raw === null) return defaultValue;
  const trimmed = String(raw).trim();
  if (trimmed === '') return defaultValue;
  if (!/^\d+$/.test(trimmed)) {
    return defaultValue;
  }
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
    return defaultValue;
  }
  return n;
}

test('parseLimitEnv: undefined / null / empty falls back to default', () => {
  assert.equal(parseLimitEnv('X', undefined, 3), 3);
  assert.equal(parseLimitEnv('X', null, 3), 3);
  assert.equal(parseLimitEnv('X', '', 3), 3);
  assert.equal(parseLimitEnv('X', '   ', 3), 3);
});

test('parseLimitEnv: pure non-negative integer string is accepted', () => {
  assert.equal(parseLimitEnv('X', '0', 3), 0);
  assert.equal(parseLimitEnv('X', '7', 3), 7);
  assert.equal(parseLimitEnv('X', '100', 3), 100);
  assert.equal(parseLimitEnv('X', '  42  ', 3), 42);
});

test('parseLimitEnv: rejects numeric prefix with garbage trailer (the #1328 finding)', () => {
  // Number.parseInt('100abc', 10) silently returns 100 — that is the
  // exact bypass this finding is about. The strict regex must reject
  // anything that is not entirely digits and fall back to the default
  // so a workflow_dispatch typo like `max_dispatch=100abc` cannot
  // inflate the rate limit past the documented value.
  assert.equal(parseLimitEnv('TRIAGE_MAX_DISPATCH', '100abc', 3), 3);
  assert.equal(parseLimitEnv('TRIAGE_MAX_DISPATCH', '3 ; rm -rf /', 3), 3);
  assert.equal(parseLimitEnv('TRIAGE_MAX_DISPATCH', '5.0', 3), 3);
  assert.equal(parseLimitEnv('TRIAGE_MAX_DISPATCH', '0x10', 3), 3);
  assert.equal(parseLimitEnv('TRIAGE_MAX_DISPATCH', '1e3', 3), 3);
});

test('parseLimitEnv: rejects non-numeric, negative, and fractional input', () => {
  assert.equal(parseLimitEnv('X', 'abc', 25), 25);
  assert.equal(parseLimitEnv('X', 'unlimited', 25), 25);
  assert.equal(parseLimitEnv('X', '-5', 25), 25);
  assert.equal(parseLimitEnv('X', '-0', 25), 25);
  assert.equal(parseLimitEnv('X', '3.7', 25), 25);
  assert.equal(parseLimitEnv('X', '+3', 25), 25);
  assert.equal(parseLimitEnv('X', 'NaN', 25), 25);
  assert.equal(parseLimitEnv('X', 'Infinity', 25), 25);
});

test('static guard: parseLimitEnv stays in the canonical source (no silent revert to bare parseInt)', () => {
  const src = readFileSync(SCRIPT_PATH, 'utf-8');
  assert.match(
    src,
    /function parseLimitEnv\s*\(/,
    'parseLimitEnv must remain defined in issue-auto-triage.mjs — finding #1328 documents why a bare Number.parseInt is unsafe',
  );
  // The strict-numeric regex is the load-bearing piece — without
  // `^\d+$` (or a stricter equivalent), parseInt-style prefix
  // matching accepts `100abc` and the rate-limit cap can be inflated
  // by typos in workflow_dispatch inputs.
  assert.match(
    src,
    /\/\^\\d\+\$\//,
    'parseLimitEnv must use a full-string digits regex (/^\\d+$/) so prefix-numeric garbage like "100abc" is rejected',
  );
  // The MAX_* env vars MUST be routed through the helper. A future
  // refactor that re-introduces bare `Number.parseInt(process.env.TRIAGE_MAX_*` would
  // resurrect the exact #1328 finding.
  assert.match(
    src,
    /MAX_DISPATCH\s*=\s*parseLimitEnv\(\s*'TRIAGE_MAX_DISPATCH'/,
    'MAX_DISPATCH must go through parseLimitEnv',
  );
  assert.match(
    src,
    /MAX_CLOSE\s*=\s*parseLimitEnv\(\s*'TRIAGE_MAX_CLOSE'/,
    'MAX_CLOSE must go through parseLimitEnv',
  );
  assert.doesNotMatch(
    src,
    /Number\.parseInt\(\s*process\.env\.TRIAGE_MAX_/,
    'TRIAGE_MAX_* must not be parsed with bare Number.parseInt — that is the #1328 regression',
// Mirror of parsePositiveIntEnv in scripts/issue-auto-triage.mjs. Kept
// inline so the test can exercise the helper without importing the
// script (which spawns `gh` at import-time when env is set). The
// static-source guard below asserts the canonical implementation
// still exists.
function parsePositiveIntEnv(name, raw, fallback) {
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  if (raw === undefined || raw === null || raw === '') return { value: fallback, warnings };
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) {
    warn(
      `[warn] ${name}=${JSON.stringify(raw)} is not a non-negative integer; falling back to ${fallback}`,
    );
    return { value: fallback, warnings };
  }
  return { value: n, warnings };
}

test('parsePositiveIntEnv: undefined / empty string falls back without warning', () => {
  for (const raw of [undefined, null, '']) {
    const r = parsePositiveIntEnv('TRIAGE_MAX_DISPATCH', raw, 3);
    assert.equal(r.value, 3);
    assert.equal(r.warnings.length, 0);
  }
});

test('parsePositiveIntEnv: valid non-negative integer string is parsed', () => {
  assert.deepEqual(parsePositiveIntEnv('X', '7', 3), { value: 7, warnings: [] });
  assert.deepEqual(parsePositiveIntEnv('X', '0', 3), { value: 0, warnings: [] });
  assert.deepEqual(parsePositiveIntEnv('X', '  12  ', 3), { value: 12, warnings: [] });
});

test('parsePositiveIntEnv: NaN-producing input falls back to default and warns', () => {
  // This is the exact failure mode the finding flags: a non-numeric
  // env var made parseInt return NaN, which silently disabled both
  // rate-limit checks because `count >= NaN` is always false.
  for (const raw of ['abc', 'unlimited', 'NaN', '--', 'true']) {
    const r = parsePositiveIntEnv('TRIAGE_MAX_DISPATCH', raw, 3);
    assert.equal(r.value, 3, `expected NaN input ${JSON.stringify(raw)} to fall back to 3`);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /TRIAGE_MAX_DISPATCH/);
  }
});

test('parsePositiveIntEnv: negative integer falls back to default and warns', () => {
  // `parseInt('-5', 10)` is -5. Without the guard, `0 >= -5` is true
  // immediately so the loop short-circuits and the script silently
  // does nothing. The fallback restores the documented default.
  const r = parsePositiveIntEnv('TRIAGE_MAX_CLOSE', '-5', 25);
  assert.equal(r.value, 25);
  assert.equal(r.warnings.length, 1);
});

test('parsePositiveIntEnv: parseInt-truncated floats are accepted (parseInt drops the fractional part)', () => {
  // `parseInt('3.7', 10)` is 3 — this is intentional Node behaviour
  // and matches how the original code parsed env vars. We don't
  // reject it because it doesn't trigger the NaN failure mode this
  // helper is here to guard against.
  const r = parsePositiveIntEnv('X', '3.7', 99);
  assert.equal(r.value, 3);
  assert.equal(r.warnings.length, 0);
});

test('static guard: issue-auto-triage.mjs still validates env-var caps for NaN', () => {
  // Regression guard for the finding in issue #1239: a bare
  // `Number.parseInt(envVar || fallback, 10)` silently produced NaN
  // for non-numeric input, and every `count >= NaN` comparison
  // evaluated to false so the loops processed the whole backlog.
  // The canonical fix is parsePositiveIntEnv() — this guard fails
  // if a future refactor drops it or reverts the call sites.
  const src = readFileSync(SCRIPT_PATH, 'utf-8');
  assert.match(src, /function parsePositiveIntEnv\s*\(/);
  assert.match(
    src,
    /const MAX_DISPATCH\s*=\s*parsePositiveIntEnv\(\s*'TRIAGE_MAX_DISPATCH'/,
    'MAX_DISPATCH must be parsed through parsePositiveIntEnv so non-numeric env vars cannot disable the cap',
  );
  assert.match(
    src,
    /const MAX_CLOSE\s*=\s*parsePositiveIntEnv\(\s*'TRIAGE_MAX_CLOSE'/,
    'MAX_CLOSE must be parsed through parsePositiveIntEnv so non-numeric env vars cannot disable the cap',
  );
  // The helper must reject NaN. Number.isInteger() returns false for
  // NaN, which is the chokepoint — guarding the method name keeps
  // the test specific to the actual fix instead of any later rewrite
  // that happens to use a different sentinel.
  const helperBody = src.match(/function parsePositiveIntEnv\s*\([\s\S]*?\n\}/);
  assert.ok(helperBody, 'parsePositiveIntEnv body must be present');
  assert.match(
    helperBody[0],
    /Number\.isInteger\s*\(/,
    'parsePositiveIntEnv must use Number.isInteger() (or equivalent) to reject NaN',
  );
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

// Mirror of parseLimitEnv() in scripts/issue-auto-triage.mjs. Same
// inline-mirror pattern as extractClosesRefs above — the script
// can't be imported (it spawns gh at module load when env is set)
// so we re-declare the pure helper and pin it with a static guard.
const NON_NEGATIVE_INT_RE = /^\d+$/;
function parseLimitEnv(name, raw, defaultValue, warn = () => {}) {
  if (raw === undefined || raw === null) {
    return defaultValue;
  }
  const trimmed = typeof raw === 'string' ? raw.trim() : String(raw);
  const parsed = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
  const trimmed = String(raw).trim();
  if (trimmed === '') {
    return defaultValue;
  }
  if (!NON_NEGATIVE_INT_RE.test(trimmed)) {
    warn(
      `[triage] ${name}=${JSON.stringify(raw)} is not a non-negative integer; ` +
        `falling back to default=${defaultValue} to preserve rate-limit semantics.`,
    );
    return defaultValue;
  }
  const parsed = Number.parseInt(trimmed, 10);
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

test('parseLimitEnv parses valid non-negative integers', () => {
  assert.equal(parseLimitEnv('X', '0', 3), 0);
  assert.equal(parseLimitEnv('X', '5', 3), 5);
  assert.equal(parseLimitEnv('X', '25', 3), 25);
  // Surrounding whitespace (e.g. `'5\n'` from a shell heredoc) is
  // still accepted — we trim before validating.
  assert.equal(parseLimitEnv('X', '  5  ', 3), 5);
  assert.equal(parseLimitEnv('X', '5\n', 3), 5);
});

test('parseLimitEnv rejects partial / non-integer numeric input (the partial-parse bug)', () => {
  // Previously `Number.parseInt('5abc', 10)` returned 5 and
  // `Number.parseInt('1.5', 10)` returned 1 — both silently changed
  // the rate-limit value compared to what the user typed in
  // workflow_dispatch, violating the "garbage input → default"
  // contract advertised in the helper's doc-comment. Strict
  // pre-validation now routes them through the default + warning.
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  assert.equal(parseLimitEnv('TRIAGE_MAX_DISPATCH', '5abc', 3, warn), 3);
  assert.equal(parseLimitEnv('TRIAGE_MAX_CLOSE', '1.5', 25, warn), 25);
  assert.equal(parseLimitEnv('X', '1e2', 3, warn), 3);
  assert.equal(parseLimitEnv('X', '0x10', 3, warn), 3);
  assert.equal(parseLimitEnv('X', '3 4', 3, warn), 3);
  assert.equal(warnings.length, 5);
  assert.match(warnings[0], /TRIAGE_MAX_DISPATCH/);
  assert.match(warnings[1], /TRIAGE_MAX_CLOSE/);
});

test('parseLimitEnv trims surrounding whitespace (heredoc / shell-export quirks)', () => {
  // `'5\n'` from a heredoc, `' 5 '` from a copy-paste — both should
  // still mean 5. The trim happens BEFORE strict-integer validation
  // so the user-facing behaviour is "whitespace doesn't matter".
  assert.equal(parseLimitEnv('X', '5\n', 3), 5);
  assert.equal(parseLimitEnv('X', '  5  ', 3), 5);
  assert.equal(parseLimitEnv('X', '\t10\t', 3), 10);
  // All-whitespace is treated the same as empty: fall back to default.
  assert.equal(parseLimitEnv('X', '   ', 3), 3);
});

test('parseLimitEnv rejects prefix-numbers / decimals / exponents (Number.parseInt footgun)', () => {
  // The finding: Number.parseInt is prefix-permissive, so the old
  // implementation accepted '999abc' → 999, '3.5' → 3, '1e2' → 1.
  // That silently AMPLIFIES the rate-limit on garbage input (a
  // workflow_dispatch typo like max_dispatch='999abc' would dispatch
  // 999 issues in a single run). Reject every parseInt-quirk shape
  // and fall back to the default instead.
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  for (const raw of [
    '999abc', // prefix-number  → parseInt returns 999
    '3.5', // decimal        → parseInt returns 3
    '1e2', // scientific     → parseInt returns 1
    '0x10', // hex            → parseInt returns 0 (radix=10)
    '5 abc', // space-separated → parseInt returns 5
    '+5', // signed positive → parseInt returns 5; reject for strictness
    '--5', // double-negative → parseInt returns NaN; reject loudly
    '5.0', // even integer-valued decimal must be rejected
  ]) {
    assert.equal(
      parseLimitEnv('TRIAGE_MAX_DISPATCH', raw, 3, warn),
      3,
      `raw=${JSON.stringify(raw)} must fall back to default, not silently parse as a number`,
    );
  }
  assert.equal(warnings.length, 8);
  // Every warning must name the env var so a CI log skim-reader can
  // spot the misconfigured workflow_dispatch input.
  for (const msg of warnings) {
    assert.match(msg, /TRIAGE_MAX_DISPATCH/);
  }
});

test('parseLimitEnv falls back to default on NaN input (the rate-limit-bypass bug)', () => {
  // This is the actual finding: workflow_dispatch input "abc" would
  // produce NaN, and `count >= NaN` is always false, so the loop
  // never breaks and the entire backlog gets dispatched/closed.
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  assert.equal(parseLimitEnv('TRIAGE_MAX_DISPATCH', 'abc', 3, warn), 3);
  assert.equal(parseLimitEnv('TRIAGE_MAX_CLOSE', 'not-a-number', 25, warn), 25);
  assert.equal(warnings.length, 2);
  // The warning must name the offending env var so a CI log
  // skim-reader can spot the misconfigured workflow_dispatch input.
  assert.match(warnings[0], /TRIAGE_MAX_DISPATCH/);
  assert.match(warnings[1], /TRIAGE_MAX_CLOSE/);
});

test('parseLimitEnv falls back to default on negative integers', () => {
  // `-1 >= 0` is false, so a negative limit also disables the
  // rate-limit on the first loop iteration. Reject it.
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  assert.equal(parseLimitEnv('X', '-1', 3, warn), 3);
  assert.equal(parseLimitEnv('X', '-100', 3, warn), 3);
  assert.equal(warnings.length, 2);
});

test('parseLimitEnv: rate-limit comparison is sound for every fallback path', () => {
  // End-to-end shape of the bug: simulate the loop break with the
  // value parseLimitEnv returns. count is 0 at the start of the
  // loop; `0 >= LIMIT` must be a real boolean (never NaN-poisoned)
  // so the loop terminates after exactly LIMIT iterations.
  for (const raw of ['abc', '', undefined, null, '-5', 'NaN', '5abc', '1.5', '1e2']) {
  for (const raw of [
    'abc',
    '',
    undefined,
    null,
    '-5',
    'NaN',
    '999abc',
    '3.5',
    '1e2',
    '0x10',
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
  // Pin the strict `/^\d+$/` pre-validation — without it,
  // `parseInt('5abc', 10)` returns 5 and silently changes the
  // user-supplied rate-limit. The doc-comment + this guard both
  // call out that contract; a refactor that drops the regex would
  // re-introduce the partial-parse bug.
  assert.match(
    src,
    /\/\^\\d\+\$\/\.test\(/,
    'parseLimitEnv must pre-validate with /^\\d+$/ to reject partial-numeric input like "5abc" / "1.5"',
  // Pin the strict-integer regex so a future "simplification" back
  // to bare Number.parseInt reintroduces the prefix-parse footgun
  // ('999abc' → 999, '3.5' → 3, '1e2' → 1) and fails this test.
  assert.match(
    src,
    /\/\^\\d\+\$\//,
    'parseLimitEnv must validate the trimmed string with /^\\d+$/ — bare Number.parseInt is prefix-permissive and silently amplifies rate limits on garbage input',
  );
});

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

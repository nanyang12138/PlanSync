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
function parseLimitEnv(name, raw, defaultValue, warn = () => {}) {
  if (raw === undefined || raw === null || raw === '') {
    return defaultValue;
  }
  const trimmed = typeof raw === 'string' ? raw.trim() : String(raw);
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
  );
});

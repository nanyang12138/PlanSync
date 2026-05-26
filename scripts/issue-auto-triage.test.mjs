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

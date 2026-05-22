#!/usr/bin/env node
/**
 * Unit tests for the pure helpers used by review-triage.mjs and
 * review-stale.mjs. Uses node:test (Node 22 built-in) — no external
 * dependency, no workspace setup.
 *
 *   node --test scripts/review-helpers.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractJsonArray,
  fingerprint,
  normalizeForFingerprint,
  normalizeFinding,
} from './review-triage.mjs';

import { extractFilePath, extractSourcePrNumber, ageInDays } from './review-stale.mjs';

test('extractJsonArray', async (t) => {
  await t.test('parses clean JSON', () => {
    assert.equal(extractJsonArray('[{"a":1}]'), '[{"a":1}]');
  });
  await t.test('extracts from fenced code block', () => {
    assert.equal(extractJsonArray('```json\n[{"x":2}]\n```'), '[{"x":2}]');
  });
  await t.test('skips chatty preamble', () => {
    assert.equal(extractJsonArray('Here are findings: [{"sev":"must"}]'), '[{"sev":"must"}]');
  });
  await t.test('skips example brackets and finds the real array', () => {
    assert.equal(
      extractJsonArray('Examples like [a, b]. Output: [{"k":1},{"k":2}]'),
      '[{"k":1},{"k":2}]',
    );
  });
  await t.test('handles nested arrays', () => {
    assert.equal(
      extractJsonArray('noise [{"issue_numbers":[1,2,3]}] tail'),
      '[{"issue_numbers":[1,2,3]}]',
    );
  });
  await t.test('respects strings with brackets inside', () => {
    assert.equal(
      extractJsonArray('pre [{"text":"oops [escape]"}] post'),
      '[{"text":"oops [escape]"}]',
    );
  });
  await t.test('handles empty array', () => {
    assert.equal(extractJsonArray('[]'), '[]');
  });
  await t.test('returns input when no array', () => {
    assert.equal(extractJsonArray('just prose'), 'just prose');
  });
  await t.test('handles null/undefined gracefully', () => {
    assert.equal(extractJsonArray(''), '');
    assert.equal(extractJsonArray(null), null);
  });
});

test('fingerprint', async (t) => {
  await t.test('is deterministic for same input', () => {
    const a = fingerprint('src/foo.ts', 'missing null check');
    const b = fingerprint('src/foo.ts', 'missing null check');
    assert.equal(a, b);
  });
  await t.test('differs across files', () => {
    const a = fingerprint('src/foo.ts', 'missing null check');
    const b = fingerprint('src/bar.ts', 'missing null check');
    assert.notEqual(a, b);
  });
  await t.test('differs across texts', () => {
    const a = fingerprint('src/foo.ts', 'missing null check');
    const b = fingerprint('src/foo.ts', 'racy mutex');
    assert.notEqual(a, b);
  });
  await t.test('returns 12 hex chars', () => {
    const fp = fingerprint('a/b.ts', 'something');
    assert.match(fp, /^[0-9a-f]{12}$/);
  });
});

test('normalizeForFingerprint', async (t) => {
  await t.test('normalizes case', () => {
    const a = normalizeForFingerprint('src/foo.ts', 'Missing null check');
    const b = normalizeForFingerprint('src/foo.ts', 'missing null check');
    assert.equal(a, b);
  });
  await t.test('strips markdown emphasis', () => {
    const a = normalizeForFingerprint('src/foo.ts', '**missing** null check');
    const b = normalizeForFingerprint('src/foo.ts', 'missing null check');
    assert.equal(a, b);
  });
  await t.test('collapses whitespace', () => {
    const a = normalizeForFingerprint('src/foo.ts', 'missing   null    check');
    const b = normalizeForFingerprint('src/foo.ts', 'missing null check');
    assert.equal(a, b);
  });
});

test('normalizeFinding', async (t) => {
  await t.test('coerces severity case', () => {
    assert.equal(normalizeFinding({ severity: 'MUST' }).severity, 'must');
  });
  await t.test('falls back to noise for unknown severity', () => {
    assert.equal(normalizeFinding({ severity: 'critical' }).severity, 'noise');
  });
  await t.test('coerces line number from string', () => {
    assert.equal(normalizeFinding({ line: '42' }).line, 42);
  });
  await t.test('keeps numeric line', () => {
    assert.equal(normalizeFinding({ line: 88 }).line, 88);
  });
  await t.test('zero on missing line', () => {
    assert.equal(normalizeFinding({}).line, 0);
  });
  await t.test('truncates oversized text', () => {
    const big = 'x'.repeat(5000);
    assert.ok(normalizeFinding({ text: big }).text.length <= 1000);
  });
  await t.test('defaults category to uncategorized', () => {
    assert.equal(normalizeFinding({}).category, 'uncategorized');
  });
});

test('extractFilePath', async (t) => {
  await t.test('extracts path from triage body', () => {
    const body = `**File**: \`packages/api/src/lib/auth.ts\`:42`;
    assert.equal(extractFilePath(body), 'packages/api/src/lib/auth.ts');
  });
  await t.test('strips line suffix', () => {
    const body = `**File**: \`a/b/c.ts\`:99`;
    assert.equal(extractFilePath(body), 'a/b/c.ts');
  });
  await t.test('returns null on (unknown)', () => {
    const body = `**File**: \`(unknown)\``;
    assert.equal(extractFilePath(body), null);
  });
  await t.test('returns null when missing', () => {
    assert.equal(extractFilePath('no file marker here'), null);
  });
  await t.test('returns null on empty body', () => {
    assert.equal(extractFilePath(''), null);
    assert.equal(extractFilePath(null), null);
  });
});

test('extractSourcePrNumber', async (t) => {
  await t.test('matches Source: PR #N', () => {
    const body = '**Source**: PR #312 · cursor-review';
    assert.equal(extractSourcePrNumber(body), 312);
  });
  await t.test('matches Source line with extra prose', () => {
    const body =
      '**Source**: PR #420 · cursor-review · [comment](https://github.com/o/r/pull/420#issuecomment-99)';
    assert.equal(extractSourcePrNumber(body), 420);
  });
  await t.test('returns null when absent', () => {
    assert.equal(extractSourcePrNumber('nothing here'), null);
  });
  await t.test('does not catch unrelated #N before Source', () => {
    const body = 'Saw #99 elsewhere. **Source**: PR #312 actual';
    assert.equal(extractSourcePrNumber(body), 312);
  });
});

test('ageInDays', async (t) => {
  await t.test('zero for now', () => {
    const age = ageInDays(new Date().toISOString());
    assert.ok(age < 0.01);
  });
  await t.test('roughly 7 for a week ago', () => {
    const past = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const age = ageInDays(past);
    assert.ok(age > 6.9 && age < 7.1, `expected ~7, got ${age}`);
  });
});

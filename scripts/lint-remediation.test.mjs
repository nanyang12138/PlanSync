#!/usr/bin/env node
/**
 * Self-tests for scripts/lint-remediation.mjs.
 *
 *   node --test scripts/lint-remediation.test.mjs
 *
 * Targets the PR-A2 review-findings #332 (no automated test for the
 * linter), #346 (271-line validator added without unit cases), #343
 * (multi-line fix_steps was wrongly flagged), #356 (depends_on accepted
 * non-R-ID tokens), #330 (interim_for + depends_on coupling not
 * detected), #328 (R-ID tie-break on equal severity), #327 / #342 / #354
 * (--dispatch mode contract).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lint,
  parseEntries,
  pickNextDispatch,
  parseIdList,
  detectCycle,
} from './lint-remediation.mjs';

function fixture(extra) {
  // Minimal valid document with the appendix severity totals block and
  // a couple of well-formed entries — every test extends the document
  // body with `extra` so the linter has a known baseline to assert
  // against. Severity totals MUST match the count in the body.
  const HEAD = `# PlanSync 修复路线图

## 修复条目清单

### B1 — Test batch

`;
  // Default body: two entries, both well-formed (CRITICAL + HIGH).
  const DEFAULT_BODY = `#### R-200 [CRITICAL] base critical
- **status**: done
- **batch**: B1
- **depends_on**: —
- **effort**: small
- **files**: a/b
- **fix_steps**: do thing
- **verification**: vitest passes

---

#### R-201 [HIGH] base high
- **status**: done
- **batch**: B1
- **depends_on**: R-200
- **effort**: small
- **files**: c/d
- **fix_steps**: do other thing
- **verification**: vitest passes

`;
  const body = extra ?? DEFAULT_BODY;
  // Compute severity counts from the body so the appendix matches
  const sevCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const m of body.matchAll(/^#### R-\d+ \[(\w+)\]/gm)) {
    if (sevCounts[m[1]] !== undefined) sevCounts[m[1]] += 1;
  }
  const TAIL = `\n## 附录 A — 完整问题索引

**统计**（含 2026-05-22 追加）：

- CRITICAL: 0 + ${sevCounts.CRITICAL} = **${sevCounts.CRITICAL}**
- HIGH: 0 + ${sevCounts.HIGH} = **${sevCounts.HIGH}**
- MEDIUM: 0 + ${sevCounts.MEDIUM} = **${sevCounts.MEDIUM}**
- LOW: 0 + ${sevCounts.LOW} = **${sevCounts.LOW}**
`;
  return HEAD + body + TAIL;
}

test('parseEntries extracts id / severity / fields with line numbers', () => {
  const text = fixture();
  const entries = parseEntries(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, 'R-200');
  assert.equal(entries[0].severity, 'CRITICAL');
  assert.equal(entries[0].fields.status.value, 'done');
  assert.equal(entries[0].fields.batch.value, 'B1');
  assert.equal(entries[0].fields.fix_steps.hasContent, true);
});

test('parseIdList handles em-dash, blanks, and CSV', () => {
  assert.deepEqual(parseIdList(''), []);
  assert.deepEqual(parseIdList('—'), []);
  assert.deepEqual(parseIdList('R-001'), ['R-001']);
  assert.deepEqual(parseIdList('R-001, R-002, R-003'), ['R-001', 'R-002', 'R-003']);
  assert.deepEqual(parseIdList('  R-001 ,  R-002 '), ['R-001', 'R-002']);
});

test('lint: clean baseline produces no errors', () => {
  const { errors, sevCounts } = lint(fixture());
  assert.deepEqual(errors, []);
  assert.equal(sevCounts.CRITICAL, 1);
  assert.equal(sevCounts.HIGH, 1);
});

test('#343: multi-line fix_steps with indented numbered list is accepted', () => {
  const body = `#### R-300 [HIGH] multi-line fix_steps
- **status**: pending
- **batch**: B1
- **depends_on**: —
- **effort**: small
- **files**: a/b
- **fix_steps**:
  1. step one
  2. step two
- **verification**: vitest

`;
  const { errors } = lint(fixture(body));
  // The previous "same-line text only" check would have flagged fix_steps
  // here because the value-on-the-same-line is empty.
  assert.equal(
    errors.filter((e) => e.includes('fix_steps')).length,
    0,
    `expected no fix_steps errors, got: ${errors.join('; ')}`,
  );
});

test('#343: same field with neither same-line text nor a child list is flagged', () => {
  const body = `#### R-301 [HIGH] empty fix_steps
- **status**: pending
- **batch**: B1
- **depends_on**: —
- **effort**: small
- **files**: a/b
- **fix_steps**:
- **verification**: vitest

`;
  const { errors } = lint(fixture(body));
  assert.ok(
    errors.some((e) => e.includes("R-301") && e.includes('fix_steps')),
    `expected R-301 fix_steps error; got: ${errors.join('; ')}`,
  );
});

test('#356: depends_on with a non-R-ID token (e.g. Chinese paren) is an error, not skipped', () => {
  const body = `#### R-302 [HIGH] bad dep token
- **status**: pending
- **batch**: B1
- **depends_on**: R-200（先做 X）
- **effort**: small
- **files**: a/b
- **fix_steps**: x
- **verification**: vitest

`;
  const { errors } = lint(fixture(body));
  assert.ok(
    errors.some((e) => e.includes("R-302") && e.includes('non-machine-readable')),
    `expected R-302 non-machine-readable error; got: ${errors.join('; ')}`,
  );
});

test('#330: interim_for must not also appear in depends_on', () => {
  const body = `#### R-303 [HIGH] interim+dep clash
- **status**: pending
- **batch**: B1
- **depends_on**: R-200
- **interim_for**: R-200
- **effort**: small
- **files**: a/b
- **fix_steps**: x
- **verification**: vitest

`;
  const { errors } = lint(fixture(body));
  assert.ok(
    errors.some((e) => e.includes('R-303') && e.includes('interim_for') && e.includes('depends_on')),
    `expected R-303 interim_for+depends_on error; got: ${errors.join('; ')}`,
  );
});

test('dedup mutual exclusion: superseded_by + interim_for on same entry is rejected', () => {
  const body = `#### R-304 [HIGH] dup dedup fields
- **status**: pending
- **batch**: B1
- **depends_on**: —
- **superseded_by**: R-200
- **interim_for**: R-200
- **effort**: small
- **files**: a/b
- **fix_steps**: x
- **verification**: vitest

`;
  const { errors } = lint(fixture(body));
  assert.ok(
    errors.some((e) => e.includes('R-304') && e.includes('only one allowed')),
    `expected mutual-exclusion error; got: ${errors.join('; ')}`,
  );
});

test('depends_on cycle is detected', () => {
  const body = `#### R-305 [HIGH] a
- **status**: pending
- **batch**: B1
- **depends_on**: R-306
- **effort**: small
- **files**: a/b
- **fix_steps**: x
- **verification**: vitest

#### R-306 [HIGH] b
- **status**: pending
- **batch**: B1
- **depends_on**: R-305
- **effort**: small
- **files**: a/b
- **fix_steps**: x
- **verification**: vitest

`;
  const { errors } = lint(fixture(body));
  assert.ok(
    errors.some((e) => e.includes('cycle')),
    `expected cycle error; got: ${errors.join('; ')}`,
  );
});

test('detectCycle helper unit', () => {
  // R-A → R-B → R-A
  const cycle = detectCycle(new Map([['R-A', ['R-B']], ['R-B', ['R-A']]]));
  assert.ok(cycle && cycle.length >= 2, `got ${JSON.stringify(cycle)}`);
});

test('appendix severity totals must match actual counts', () => {
  // Body has 1 CRITICAL + 1 HIGH; tail claims 0 + 0 (mismatch).
  const broken =
    `# PlanSync\n## 修复条目清单\n### B1\n` +
    `#### R-200 [CRITICAL] x\n- **status**: done\n- **batch**: B1\n- **depends_on**: —\n- **effort**: small\n- **files**: a\n- **fix_steps**: x\n- **verification**: x\n\n` +
    `#### R-201 [HIGH] y\n- **status**: done\n- **batch**: B1\n- **depends_on**: —\n- **effort**: small\n- **files**: a\n- **fix_steps**: x\n- **verification**: x\n\n` +
    `## 附录 A\n- CRITICAL: 0 + 0 = **0**\n- HIGH: 0 + 0 = **0**\n- MEDIUM: 0 + 0 = **0**\n- LOW: 0 + 0 = **0**\n`;
  const { errors } = lint(broken);
  assert.ok(
    errors.some((e) => e.includes('CRITICAL = 0 but actual is 1')),
    `expected CRITICAL mismatch error; got: ${errors.join('; ')}`,
  );
});

test('legacy entries (R-001..R-134) only WARN on missing fields', () => {
  const body = `#### R-001 [HIGH] legacy thin
- **status**: pending
- **batch**: B1
- **depends_on**: —
- **effort**: small

`;
  const { errors, warnings } = lint(fixture(body));
  // No errors — legacy is warn-only on missing fields.
  assert.deepEqual(
    errors.filter((e) => e.includes('R-001')),
    [],
  );
  assert.ok(
    warnings.some((w) => w.includes('R-001') && w.includes("missing required field 'files'")),
    `expected legacy warn; got: ${warnings.join('; ')}`,
  );
});

test('#328: pickNextDispatch breaks ties by R-ID natural order', () => {
  // Two entries, both pending, both HIGH. Expect R-100 (lower) before R-200.
  const text = fixture(`#### R-100 [HIGH] earlier
- **status**: pending
- **batch**: B1
- **depends_on**: —
- **effort**: small
- **files**: a
- **fix_steps**: x
- **verification**: x

#### R-101 [CRITICAL] critical wins
- **status**: pending
- **batch**: B1
- **depends_on**: —
- **effort**: small
- **files**: a
- **fix_steps**: x
- **verification**: x

#### R-102 [HIGH] later
- **status**: pending
- **batch**: B1
- **depends_on**: —
- **effort**: small
- **files**: a
- **fix_steps**: x
- **verification**: x

`);
  const entries = parseEntries(text);
  const pick = pickNextDispatch(entries);
  // CRITICAL beats HIGH regardless of R-ID order.
  assert.equal(pick?.id, 'R-101');

  // Drop the CRITICAL row and re-pick: now only HIGH+HIGH remains, lower
  // R-ID wins.
  const high = entries.filter((e) => e.severity !== 'CRITICAL');
  const pick2 = pickNextDispatch(high);
  assert.equal(pick2?.id, 'R-100');
});

test('#327 / #342 / #354: --dispatch contract — interim_for skips when target is in_progress|done|cancelled', () => {
  const text = fixture(`#### R-110 [HIGH] terminal
- **status**: in_progress
- **batch**: B1
- **depends_on**: —
- **effort**: small
- **files**: a
- **fix_steps**: x
- **verification**: x

#### R-111 [HIGH] interim for in_progress target
- **status**: pending
- **batch**: B1
- **depends_on**: —
- **interim_for**: R-110
- **effort**: small
- **files**: a
- **fix_steps**: x
- **verification**: x

`);
  const entries = parseEntries(text);
  const pick = pickNextDispatch(entries);
  // R-111 must be skipped because R-110 is in_progress.
  assert.equal(pick, null);
});

test('--dispatch: depends_on accepts {done, cancelled} as satisfied', () => {
  const text = fixture(`#### R-120 [HIGH] a
- **status**: cancelled
- **batch**: B1
- **depends_on**: —
- **cancelled_by**: R-121
- **effort**: small
- **files**: a
- **fix_steps**: x
- **verification**: x

#### R-121 [HIGH] downstream
- **status**: pending
- **batch**: B1
- **depends_on**: R-120
- **effort**: small
- **files**: a
- **fix_steps**: x
- **verification**: x

`);
  const entries = parseEntries(text);
  const pick = pickNextDispatch(entries);
  // R-121 should be picked because R-120 is cancelled (== done for deps).
  assert.equal(pick?.id, 'R-121');
});

test('--dispatch: superseded_by hard-skips regardless of severity', () => {
  const text = fixture(`#### R-130 [CRITICAL] superseded
- **status**: pending
- **batch**: B1
- **depends_on**: —
- **superseded_by**: R-131
- **effort**: small
- **files**: a
- **fix_steps**: x
- **verification**: x

#### R-131 [HIGH] target
- **status**: pending
- **batch**: B1
- **depends_on**: —
- **effort**: small
- **files**: a
- **fix_steps**: x
- **verification**: x

`);
  const entries = parseEntries(text);
  const pick = pickNextDispatch(entries);
  // R-130 is CRITICAL but superseded → R-131 (HIGH) wins.
  assert.equal(pick?.id, 'R-131');
});

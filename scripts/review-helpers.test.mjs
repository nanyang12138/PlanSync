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
  consumeSse,
} from './review-triage.mjs';

import { extractFilePath, extractSourcePrNumber, ageInDays } from './review-stale.mjs';

/**
 * Build a fake `ReadableStreamDefaultReader`-compatible object that
 * yields the given UTF-8 byte chunks (each chunk simulates one network
 * frame from the SSE server). After all chunks are consumed the next
 * read() resolves with `{ done: true }`.
 */
function makeFakeReader(chunks) {
  const enc = new TextEncoder();
  const queue = chunks.map((c) => (c instanceof Uint8Array ? c : enc.encode(c)));
  return {
    read: async () => {
      if (queue.length === 0) return { value: undefined, done: true };
      return { value: queue.shift(), done: false };
    },
  };
}

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

test('consumeSse', async (t) => {
  await t.test('happy path: assembles assistant deltas, sees terminal result', async () => {
    const sse =
      'event: status\ndata: {"runId":"r1","status":"RUNNING"}\n\n' +
      'event: assistant\ndata: {"text":"Hello "}\n\n' +
      'event: assistant\ndata: {"text":"world"}\n\n' +
      'event: result\ndata: {"runId":"r1","status":"FINISHED"}\n\n';
    const r = await consumeSse(makeFakeReader([sse]), new TextDecoder());
    assert.equal(r.output, 'Hello world');
    assert.equal(r.lastStatus, 'FINISHED');
    assert.equal(r.lastError, null);
    assert.equal(r.sawTerminal, true);
  });

  await t.test('chunk boundary in middle of an event field', async () => {
    // Split the byte stream right in the middle of "Hello " — exercises
    // the streaming-decoder buffering path.
    const sse =
      'event: assistant\ndata: {"text":"Hello "}\n\n' +
      'event: assistant\ndata: {"text":"world"}\n\n' +
      'event: done\ndata: {}\n\n';
    const cut = sse.length / 2;
    const r = await consumeSse(
      makeFakeReader([sse.slice(0, cut), sse.slice(cut)]),
      new TextDecoder(),
    );
    assert.equal(r.output, 'Hello world');
    assert.equal(r.sawTerminal, true);
  });

  await t.test('flushes a trailing event missing a final blank line', async () => {
    // No "\n\n" at the end of the stream — this is the bug the previous
    // implementation had: the last event was silently dropped.
    const sse =
      'event: assistant\ndata: {"text":"abc"}\n\n' +
      'event: result\ndata: {"runId":"r1","status":"FINISHED"}';
    const r = await consumeSse(makeFakeReader([sse]), new TextDecoder());
    assert.equal(r.output, 'abc');
    assert.equal(r.lastStatus, 'FINISHED');
    assert.equal(r.sawTerminal, true);
  });

  await t.test('captures error event payload + sawTerminal=true', async () => {
    const sse =
      'event: assistant\ndata: {"text":"partial"}\n\n' +
      'event: error\ndata: {"code":"agent_failure","message":"boom"}\n\n';
    const r = await consumeSse(makeFakeReader([sse]), new TextDecoder());
    assert.equal(r.lastError, 'boom');
    assert.equal(r.sawTerminal, true);
    assert.equal(r.output, 'partial');
  });

  await t.test('no terminal event ⇒ sawTerminal=false (premature close)', async () => {
    const sse = 'event: assistant\ndata: {"text":"only this"}\n\n';
    const r = await consumeSse(makeFakeReader([sse]), new TextDecoder());
    assert.equal(r.output, 'only this');
    assert.equal(r.lastStatus, null);
    assert.equal(r.sawTerminal, false);
  });

  await t.test('ignores SSE comment lines and unknown event types', async () => {
    const sse =
      ': keep-alive\n\n' +
      'event: heartbeat\ndata: {}\n\n' +
      'event: assistant\ndata: {"text":"x"}\n\n' +
      'event: thinking\ndata: {"text":"shouldnt-go-into-output"}\n\n' +
      'event: done\ndata: {}\n\n';
    const r = await consumeSse(makeFakeReader([sse]), new TextDecoder());
    assert.equal(r.output, 'x');
    assert.equal(r.sawTerminal, true);
  });

  await t.test('tolerates malformed JSON in a single delta', async () => {
    const sse =
      'event: assistant\ndata: {"text":"good "}\n\n' +
      'event: assistant\ndata: not-json\n\n' +
      'event: assistant\ndata: {"text":"end"}\n\n' +
      'event: done\ndata: {}\n\n';
    const r = await consumeSse(makeFakeReader([sse]), new TextDecoder());
    assert.equal(r.output, 'good end');
    assert.equal(r.sawTerminal, true);
  });

  await t.test('handles \\r\\n line endings', async () => {
    const sse =
      'event: assistant\r\ndata: {"text":"hi"}\r\n\r\n' + 'event: done\r\ndata: {}\r\n\r\n';
    const r = await consumeSse(makeFakeReader([sse]), new TextDecoder());
    assert.equal(r.output, 'hi');
    assert.equal(r.sawTerminal, true);
  });
});

// ---------------------------------------------------------------------
// review-dispatch.mjs Cursor API contract — static-source guards
// ---------------------------------------------------------------------
//
// Cursor's `v1/agents` endpoint removed the top-level `branchName`
// field in a breaking change (~2026-05). Sending it returns 400
// "Unrecognized key(s) in object: 'branchName'" and the whole
// dispatch fails. We can't easily integration-test against the live
// API (would burn quota + need a valid CURSOR_API_KEY in CI), so
// instead we lock the contract by static-source assertion: the
// agent-create body shape must NEVER list `branchName` as a top-
// level key.
// ---------------------------------------------------------------------
// review-dispatch.mjs dispatch-lock race detection — #1253
// ---------------------------------------------------------------------
//
// Regression guard for the race that opened when PR #1252 removed the
// deterministic `branchName` field from the Cursor v1/agents body: two
// concurrent dispatch runs that both passed the in-script
// `labelSet.has('dispatched')` check would both call `createCursorAgent`,
// and without a per-issue branch collision at Cursor's side they'd both
// succeed — spawning duplicate agents / opening duplicate PRs for the
// same issue. The fix re-verifies lock ownership by reading the issue
// events API after `addLabels` and comparing the most recent `labeled`
// event's `created_at` to the local pre-call timestamp. This block
// exercises the pure decision helper that drives that check.
test('didWeAcquireDispatchLock', async (t) => {
  const { didWeAcquireDispatchLock } = await import('./review-dispatch.mjs');
  const LOCK = 'dispatched';
  const baseIso = (ts) => new Date(ts).toISOString();

  await t.test('no events ⇒ assume win (propagation lag tolerated)', () => {
    assert.equal(
      didWeAcquireDispatchLock({
        events: [],
        lockLabel: LOCK,
        preAddLabelsAtMs: Date.now(),
      }),
      true,
    );
  });

  await t.test('no labeled events for the lock ⇒ assume win', () => {
    const now = Date.now();
    assert.equal(
      didWeAcquireDispatchLock({
        events: [
          { event: 'labeled', label: { name: 'review-finding' }, created_at: baseIso(now - 60_000) },
          { event: 'commented', created_at: baseIso(now - 30_000) },
        ],
        lockLabel: LOCK,
        preAddLabelsAtMs: now,
      }),
      true,
    );
  });

  await t.test('our own labeled event (after pre-call ts) ⇒ win', () => {
    const preCall = Date.now();
    assert.equal(
      didWeAcquireDispatchLock({
        events: [
          { event: 'labeled', label: { name: LOCK }, created_at: baseIso(preCall + 300) },
        ],
        lockLabel: LOCK,
        preAddLabelsAtMs: preCall,
      }),
      true,
    );
  });

  await t.test('peer labeled event well before pre-call ts ⇒ lose', () => {
    const preCall = Date.now();
    assert.equal(
      didWeAcquireDispatchLock({
        events: [
          { event: 'labeled', label: { name: LOCK }, created_at: baseIso(preCall - 30_000) },
        ],
        lockLabel: LOCK,
        preAddLabelsAtMs: preCall,
      }),
      false,
    );
  });

  await t.test('peer labeled event within tolerance ⇒ win (treated as us)', () => {
    // Clock skew between local Node clock and GitHub server clock is
    // expected to be sub-second on NTP-synced runners; the default
    // toleranceMs (1500) covers normal drift.
    const preCall = Date.now();
    assert.equal(
      didWeAcquireDispatchLock({
        events: [
          { event: 'labeled', label: { name: LOCK }, created_at: baseIso(preCall - 500) },
        ],
        lockLabel: LOCK,
        preAddLabelsAtMs: preCall,
      }),
      true,
    );
  });

  await t.test('uses MOST RECENT labeled event (label removed and re-added)', () => {
    const preCall = Date.now();
    // Historic: label was added long ago (peer), removed, then re-added by us
    // just now. The most-recent labeled event is ours → we win.
    assert.equal(
      didWeAcquireDispatchLock({
        events: [
          { event: 'labeled', label: { name: LOCK }, created_at: baseIso(preCall - 3_600_000) },
          { event: 'unlabeled', label: { name: LOCK }, created_at: baseIso(preCall - 1_800_000) },
          { event: 'labeled', label: { name: LOCK }, created_at: baseIso(preCall + 200) },
        ],
        lockLabel: LOCK,
        preAddLabelsAtMs: preCall,
      }),
      true,
    );
  });

  await t.test('ignores other-label events that share createdAt', () => {
    const preCall = Date.now();
    assert.equal(
      didWeAcquireDispatchLock({
        events: [
          { event: 'labeled', label: { name: 'auto-triaged' }, created_at: baseIso(preCall - 60_000) },
          { event: 'labeled', label: { name: 'review-finding' }, created_at: baseIso(preCall - 60_000) },
        ],
        lockLabel: LOCK,
        preAddLabelsAtMs: preCall,
      }),
      // No labeled event for the lock found → propagation lag fallback → win.
      true,
    );
  });

  await t.test('respects custom toleranceMs (tight window catches sub-second races)', () => {
    const preCall = Date.now();
    // Peer added the label 800ms before us. With tight tolerance (250ms),
    // we correctly detect the loss.
    assert.equal(
      didWeAcquireDispatchLock({
        events: [
          { event: 'labeled', label: { name: LOCK }, created_at: baseIso(preCall - 800) },
        ],
        lockLabel: LOCK,
        preAddLabelsAtMs: preCall,
        toleranceMs: 250,
      }),
      false,
    );
  });

  await t.test('malformed event entries are skipped, not crashed on', () => {
    const preCall = Date.now();
    assert.equal(
      didWeAcquireDispatchLock({
        events: [
          null,
          { event: 'labeled' },
          { event: 'labeled', label: null, created_at: baseIso(preCall) },
          { event: 'labeled', label: { name: LOCK }, created_at: 'not-a-date' },
          { event: 'labeled', label: { name: LOCK }, created_at: baseIso(preCall + 100) },
        ],
        lockLabel: LOCK,
        preAddLabelsAtMs: preCall,
      }),
      true,
    );
  });

  await t.test('missing required args ⇒ default to win (defensive)', () => {
    assert.equal(didWeAcquireDispatchLock(), true);
    assert.equal(didWeAcquireDispatchLock({}), true);
    assert.equal(
      didWeAcquireDispatchLock({ events: [{ event: 'labeled', label: { name: 'x' } }] }),
      true,
    );
  });
});

test('review-dispatch.mjs does not send the removed `branchName` field to Cursor v1/agents', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const src = readFileSync(resolve(import.meta.dirname, 'review-dispatch.mjs'), 'utf-8');

  // createCursorAgent must still exist and must POST to /v1/agents.
  assert.match(src, /async function createCursorAgent\s*\(/);
  assert.match(src, /https:\/\/api\.cursor\.com\/v1\/agents/);

  // The body object's keys must NOT include a literal `branchName,`
  // entry — that was the field Cursor rejects with a 400. Match the
  // exact shape `branchName,` (shorthand property) or
  // `branchName:` (explicit value), restricted to the body block.
  //
  // Catches both `{ ..., branchName, ... }` and `{ ..., branchName:
  // someExpr, ... }` shapes.
  const bodyBlockRe = /const body = \{[\s\S]*?\n\s*\};/m;
  const bodyMatch = src.match(bodyBlockRe);
  assert.ok(bodyMatch, 'expected `const body = { ... };` block in createCursorAgent');
  assert.ok(
    !/\bbranchName\s*[,:]/.test(bodyMatch[0]),
    'createCursorAgent body must NOT include `branchName` (Cursor v1/agents removed the field; sending it returns 400). Cursor auto-generates a `cursor/...` branch from startingRef.',
  );

  // #1253 race-detection: with `branchName` gone, the previous implicit
  // dedup at Cursor's side (branch-collision 400) is also gone. main()
  // MUST re-verify lock ownership via the issue events API after
  // addLabels, otherwise two concurrent dispatch runs can both reach
  // createCursorAgent and spawn duplicate agents/PRs for the same issue.
  assert.match(
    src,
    /didWeAcquireDispatchLock\s*\(\s*\{[\s\S]*?lockLabel:\s*LOCK_LABEL/m,
    'main() must invoke didWeAcquireDispatchLock({ ..., lockLabel: LOCK_LABEL, ... }) between addLabels(LOCK_LABEL) and createCursorAgent — required by #1253 (the removal of `branchName` lost the implicit Cursor-side dedup).',
  );

  // #1278/#1340 cycle-scoping: the belt-and-suspenders peer-success
  // check (and its mirror in the createCursorAgent catch block) MUST
  // pass `sinceMs: cycleStartMs` so that (a) prior-cycle markers do
  // not block re-dispatch, and (b) a same-cycle peer's marker that
  // landed before our local `preAddLabelsAtMs` is NOT filtered out
  // as "stale". Using `preAddLabelsAtMs` directly as the `sinceMs`
  // (the shape PR #1296 first proposed) re-introduces #1340 — the
  // race that lets two Cursor agents spawn for the same issue.
  assert.match(
    src,
    /dispatchSucceededAlready\s*\(\s*\{\s*sinceMs:\s*cycleStartMs\s*\}\s*\)/,
    'main() must call dispatchSucceededAlready({ sinceMs: cycleStartMs }) (cycle-boundary cutoff from findLastUnlabeledMs), NOT preAddLabelsAtMs — required by #1340 (a faster same-cycle peer can post its SUCCESS marker before our local pre-addLabels timestamp; using preAddLabelsAtMs as the cutoff filters it out and lets us spawn a duplicate agent).',
  );
  assert.ok(
    !/dispatchSucceededAlready\s*\(\s*\{\s*sinceMs:\s*preAddLabelsAtMs\s*\}\s*\)/.test(src),
    'dispatchSucceededAlready must NOT be called with sinceMs: preAddLabelsAtMs — that is the #1340 buggy shape (local-clock cutoff filters out same-cycle peer markers). Use cycleStartMs from findLastUnlabeledMs instead.',
  );
});

// ---------------------------------------------------------------------
// review-dispatch.mjs cycle-scoped peer-success detection — #1278 / #1340
// ---------------------------------------------------------------------
//
// Two related regressions converged on the dispatchSucceededAlready
// belt-and-suspenders check:
//   - #1278: ANY historic SUCCESS marker (e.g. from a completed prior
//     cycle that the user explicitly ended by removing `dispatched` and
//     re-adding `cursor:dispatch`) would short-circuit the new run
//     before it ever called Cursor — re-dispatch was silently broken.
//   - #1340: the first attempted fix scoped the check with
//     `sinceMs = preAddLabelsAtMs`. That clock is LOCAL to this run,
//     while comment timestamps come from the GitHub server clock. A
//     faster same-cycle peer whose full pipeline (addLabels → Cursor →
//     SUCCESS marker) completes before our local `preAddLabelsAtMs`
//     gets its marker filtered out as "stale", and we spawn a duplicate.
//
// The fix is to cut over to a server-clock-to-server-clock cutoff: the
// timestamp of the most recent `unlabeled` event for the lock label.
// That moment is the cycle boundary — it's what re-dispatch flows
// generate, so prior-cycle markers fall behind it; and it's strictly
// before any same-cycle peer's marker (the peer must add the label
// before it can post its marker), so peer markers fall after it.
test('findLastUnlabeledMs', async (t) => {
  const { findLastUnlabeledMs } = await import('./review-dispatch.mjs');
  const LOCK = 'dispatched';
  const baseIso = (ts) => new Date(ts).toISOString();

  await t.test('returns null on empty events', () => {
    assert.equal(findLastUnlabeledMs({ events: [], lockLabel: LOCK }), null);
  });

  await t.test('returns null when no unlabeled event for the lock', () => {
    const now = Date.now();
    assert.equal(
      findLastUnlabeledMs({
        events: [
          { event: 'labeled', label: { name: LOCK }, created_at: baseIso(now - 10_000) },
          { event: 'unlabeled', label: { name: 'other-label' }, created_at: baseIso(now - 5_000) },
        ],
        lockLabel: LOCK,
      }),
      null,
    );
  });

  await t.test('returns the timestamp of a single unlabeled event', () => {
    const ts = Date.now() - 60_000;
    assert.equal(
      findLastUnlabeledMs({
        events: [{ event: 'unlabeled', label: { name: LOCK }, created_at: baseIso(ts) }],
        lockLabel: LOCK,
      }),
      ts,
    );
  });

  await t.test('returns the LATEST unlabeled timestamp across multiple cycles', () => {
    const now = Date.now();
    // Two prior cycles: dispatched added & removed twice. We want the
    // most recent removal (the start of the current cycle).
    const events = [
      { event: 'labeled', label: { name: LOCK }, created_at: baseIso(now - 7_200_000) },
      { event: 'unlabeled', label: { name: LOCK }, created_at: baseIso(now - 7_000_000) },
      { event: 'labeled', label: { name: LOCK }, created_at: baseIso(now - 3_600_000) },
      { event: 'unlabeled', label: { name: LOCK }, created_at: baseIso(now - 3_500_000) },
      { event: 'labeled', label: { name: LOCK }, created_at: baseIso(now - 60_000) },
    ];
    assert.equal(findLastUnlabeledMs({ events, lockLabel: LOCK }), now - 3_500_000);
  });

  await t.test('skips malformed events without crashing', () => {
    const ts = Date.now() - 1_000;
    assert.equal(
      findLastUnlabeledMs({
        events: [
          null,
          { event: 'unlabeled' },
          { event: 'unlabeled', label: null, created_at: baseIso(ts - 100) },
          { event: 'unlabeled', label: { name: LOCK }, created_at: 'not-a-date' },
          { event: 'unlabeled', label: { name: LOCK }, created_at: baseIso(ts) },
        ],
        lockLabel: LOCK,
      }),
      ts,
    );
  });

  await t.test('missing args ⇒ null (defensive)', () => {
    assert.equal(findLastUnlabeledMs(), null);
    assert.equal(findLastUnlabeledMs({}), null);
    assert.equal(findLastUnlabeledMs({ events: [{ event: 'unlabeled' }] }), null);
  });
});

test('hasSuccessMarkerAfter (cycle-scoped peer-success detection)', async (t) => {
  const { hasSuccessMarkerAfter } = await import('./review-dispatch.mjs');
  const baseIso = (ts) => new Date(ts).toISOString();
  const MARKER = '<!-- review-dispatch:agent -->';
  const successBody = `${MARKER}\n\n🚀 **Cursor Cloud Agent dispatched** (finding)`;
  const otherBody = `${MARKER}\n\n⚠ peer race detected, skipping.`;

  await t.test('no comments ⇒ false', () => {
    assert.equal(hasSuccessMarkerAfter({ comments: [], sinceMs: Date.now() }), false);
  });

  await t.test('marker absent ⇒ false', () => {
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [{ body: 'just a regular comment', created_at: baseIso(Date.now()) }],
        sinceMs: 0,
      }),
      false,
    );
  });

  await t.test('marker present but no SUCCESS phrase ⇒ false', () => {
    // Race-detected / failure-marker comments share the marker but not the
    // SUCCESS phrase — must not be misread as a successful peer dispatch.
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [{ body: otherBody, created_at: baseIso(Date.now()) }],
        sinceMs: 0,
      }),
      false,
    );
  });

  await t.test('SUCCESS marker after sinceMs ⇒ true (current-cycle peer)', () => {
    const now = Date.now();
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [{ body: successBody, created_at: baseIso(now) }],
        sinceMs: now - 10_000,
      }),
      true,
    );
  });

  await t.test('SUCCESS marker before sinceMs ⇒ false (prior cycle, should not block)', () => {
    // Documented re-dispatch flow: user removes `dispatched` + `cursor:dispatch`,
    // then re-applies `cursor:dispatch`. The prior cycle's success marker is
    // still on the issue but belongs to a cycle the user explicitly ended;
    // the new cycle MUST be allowed to start. (#1278)
    const cycleStart = Date.now();
    const priorMarkerTs = cycleStart - 3_600_000;
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [{ body: successBody, created_at: baseIso(priorMarkerTs) }],
        sinceMs: cycleStart,
      }),
      false,
    );
  });

  await t.test(
    '#1340: same-cycle peer marker BEFORE caller-supplied preAddLabelsAtMs is still detected when sinceMs is the cycle-start (server clock)',
    () => {
      // Reproduces the #1340 race the buggy preAddLabelsAtMs-based filter
      // missed. Run A (faster peer) addLabels at server T_lock, posts the
      // SUCCESS marker at server T_marker > T_lock. Run B is delayed, so
      // its LOCAL `preAddLabelsAtMs` is well after T_marker — but the
      // CYCLE START (last unlabeled-event timestamp, on the same server
      // clock as the marker) is BEFORE T_marker. With sinceMs = cycleStart,
      // the peer's marker is correctly preserved and B short-circuits.
      const cycleStart = 1_700_000_000_000;
      const peerMarkerTs = cycleStart + 5_000;
      const ourPreAddLabelsAtMs = peerMarkerTs + 10_000; // would have filtered the marker out under the buggy shape
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [{ body: successBody, created_at: baseIso(peerMarkerTs) }],
          sinceMs: cycleStart,
        }),
        true,
      );
      // And a sanity check: the OLD buggy shape (sinceMs = preAddLabelsAtMs)
      // would indeed have missed it. This documents the regression rather
      // than guarding the helper itself.
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [{ body: successBody, created_at: baseIso(peerMarkerTs) }],
          sinceMs: ourPreAddLabelsAtMs,
        }),
        false,
      );
    },
  );

  await t.test('sinceMs null/undefined ⇒ no filter (any historic marker counts)', () => {
    // First-ever-dispatch fallback: no prior unlabeled event exists, so
    // findLastUnlabeledMs returns null. The marker check then reduces to
    // the original "any marker counts" semantics — safe because no prior
    // cycle marker can exist without a matching unlabeled event.
    const ts = Date.now() - 60_000;
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [{ body: successBody, created_at: baseIso(ts) }],
        sinceMs: null,
      }),
      true,
    );
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [{ body: successBody, created_at: baseIso(ts) }],
        // sinceMs omitted entirely
      }),
      true,
    );
  });

  await t.test('SUCCESS marker exactly at sinceMs ⇒ true (>= comparison)', () => {
    const now = Date.now();
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [{ body: successBody, created_at: baseIso(now) }],
        sinceMs: now,
      }),
      true,
    );
  });

  await t.test('malformed comments are skipped', () => {
    const now = Date.now();
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [
          null,
          { body: null, created_at: baseIso(now) },
          { body: successBody, created_at: 'not-a-date' },
          { body: successBody, created_at: baseIso(now) },
        ],
        sinceMs: now - 1_000,
      }),
      true,
    );
  });

  await t.test('mixed comments: returns true on the first matching one', () => {
    const now = Date.now();
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [
          { body: 'unrelated', created_at: baseIso(now - 10) },
          { body: otherBody, created_at: baseIso(now - 5) },
          { body: successBody, created_at: baseIso(now) },
        ],
        sinceMs: now - 60_000,
      }),
      true,
    );
  });
});

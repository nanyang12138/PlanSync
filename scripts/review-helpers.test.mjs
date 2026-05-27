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

// ---------------------------------------------------------------------
// review-dispatch.mjs success-marker re-dispatch scoping — #1278
// ---------------------------------------------------------------------
//
// `dispatchSucceededAlready()` previously matched ANY historic success-
// marker comment, which broke the documented re-dispatch flow: removing
// `dispatched` + `cursor:dispatch` and re-applying `cursor:dispatch`
// would re-enter main(), re-acquire the lock, then hit the belt-and-
// suspenders peer-success check and bail because the PRIOR cycle's
// success marker was still on the issue. No new Cursor agent would
// ever start. The fix scopes the marker check to comments newer than
// the lock-acquisition timestamp. This block exercises the pure
// decision helper that backs the check.
test('hasSuccessMarkerAfter', async (t) => {
  const { hasSuccessMarkerAfter } = await import('./review-dispatch.mjs');
  const MARKER = '<!-- review-dispatch:agent -->';
  const PHRASE = 'Cursor Cloud Agent dispatched';
  const baseIso = (ts) => new Date(ts).toISOString();
  const mkSuccess = (ts) => ({
    body: `${MARKER}\n🚀 **${PHRASE}** (finding)\n- run: r1`,
    created_at: baseIso(ts),
  });
  const mkRaceSkip = (ts) => ({
    // Real comment shape from main() when the events-API race check
    // detected a peer winning: same MARKER, no SUCCESS phrase.
    body: `${MARKER}\n\n⚠ 检测到并发 dispatch 竞态：另一次 run 已先获取 \`dispatched\` 锁。`,
    created_at: baseIso(ts),
  });

  await t.test('no comments ⇒ no marker', () => {
    assert.equal(hasSuccessMarkerAfter({ comments: [], sinceMs: Date.now() }), false);
  });

  await t.test('current-cycle peer success after sinceMs ⇒ match', () => {
    const since = Date.now();
    assert.equal(
      hasSuccessMarkerAfter({ comments: [mkSuccess(since + 200)], sinceMs: since }),
      true,
    );
  });

  await t.test(
    'old success marker from prior re-dispatch cycle ⇒ ignored (#1278)',
    () => {
      const since = Date.now();
      // Marker is well before our pre-lock timestamp → previous cycle
      // succeeded, user has since removed `dispatched` + `cursor:dispatch`
      // and re-applied `cursor:dispatch` to retry. New run must NOT see
      // this as a peer-success.
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [mkSuccess(since - 60 * 60 * 1000)],
          sinceMs: since,
        }),
        false,
      );
    },
  );

  await t.test('peer marker within tolerance window ⇒ match (clock skew)', () => {
    const since = Date.now();
    // GitHub server clock 500ms behind local — still treated as current
    // cycle thanks to default toleranceMs (1500).
    assert.equal(
      hasSuccessMarkerAfter({ comments: [mkSuccess(since - 500)], sinceMs: since }),
      true,
    );
  });

  await t.test(
    'old marker + concurrent race-skip comment ⇒ no false positive',
    () => {
      // Realistic scenario: prior cycle succeeded long ago, current run
      // is racing a peer that just lost (posted the race-skip comment).
      // Neither should count as a current peer-success.
      const since = Date.now();
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [mkSuccess(since - 7 * 86400 * 1000), mkRaceSkip(since + 50)],
          sinceMs: since,
        }),
        false,
      );
    },
  );

  await t.test('marker without success phrase ⇒ ignored', () => {
    const since = Date.now();
    assert.equal(
      hasSuccessMarkerAfter({ comments: [mkRaceSkip(since + 100)], sinceMs: since }),
      false,
    );
  });

  await t.test('respects custom toleranceMs (tight window rejects skew)', () => {
    const since = Date.now();
    // Peer marker 800ms before us. With tight tolerance (250ms), it's
    // outside our window and treated as stale.
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [mkSuccess(since - 800)],
        sinceMs: since,
        toleranceMs: 250,
      }),
      false,
    );
  });

  await t.test('sinceMs omitted ⇒ matches any historic marker (back-compat)', () => {
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [mkSuccess(Date.now() - 24 * 60 * 60 * 1000)],
      }),
      true,
    );
  });

  await t.test('malformed comment entries are skipped, not crashed on', () => {
    const since = Date.now();
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [
          null,
          {},
          { body: null, created_at: baseIso(since + 10) },
          { body: `${MARKER} ${PHRASE}`, created_at: 'not-a-date' },
          mkSuccess(since + 100),
        ],
        sinceMs: since,
      }),
      true,
    );
  });

  await t.test('non-array / missing comments ⇒ false', () => {
    assert.equal(hasSuccessMarkerAfter(), false);
    assert.equal(hasSuccessMarkerAfter({}), false);
    assert.equal(hasSuccessMarkerAfter({ comments: null, sinceMs: Date.now() }), false);
  });
});

// ---------------------------------------------------------------------
// review-dispatch.mjs fast-re-dispatch success-marker scoping — #1396
// ---------------------------------------------------------------------
//
// After #1278 fixed the long-stale-marker case by scoping the peer
// success check to `preAddLabelsAtMs - toleranceMs`, a narrower bug
// remained: on a FAST re-dispatch (user removes `dispatched` +
// `cursor:dispatch` and re-applies `cursor:dispatch` within the 1500ms
// tolerance window), the PRIOR cycle's success marker — posted just
// before the labels were removed — falls inside the tolerance window
// and is mis-attributed to the current cycle's peer. The new run then
// short-circuits before calling Cursor and no agent ever starts.
//
// The fix uses the server-stamped `created_at` of the most recent
// `labeled` event for the lock label as the cutoff (with 0 tolerance
// — both timestamps are now server time), so prior-cycle markers
// cannot leak in regardless of how fast the user re-dispatches.
// `latestLockLabeledAtMs` is the pure helper that computes that
// timestamp; this block exercises it.
test('latestLockLabeledAtMs', async (t) => {
  const { latestLockLabeledAtMs } = await import('./review-dispatch.mjs');
  const LOCK = 'dispatched';
  const baseIso = (ts) => new Date(ts).toISOString();

  await t.test('no events ⇒ null', () => {
    assert.equal(latestLockLabeledAtMs([], LOCK), null);
    assert.equal(latestLockLabeledAtMs(null, LOCK), null);
    assert.equal(latestLockLabeledAtMs(undefined, LOCK), null);
  });

  await t.test('missing lockLabel ⇒ null', () => {
    assert.equal(
      latestLockLabeledAtMs(
        [{ event: 'labeled', label: { name: LOCK }, created_at: baseIso(Date.now()) }],
        null,
      ),
      null,
    );
  });

  await t.test('no labeled events for the lock ⇒ null', () => {
    const now = Date.now();
    assert.equal(
      latestLockLabeledAtMs(
        [
          { event: 'labeled', label: { name: 'review-finding' }, created_at: baseIso(now) },
          { event: 'commented', created_at: baseIso(now) },
        ],
        LOCK,
      ),
      null,
    );
  });

  await t.test('single labeled event ⇒ its timestamp', () => {
    const now = Date.now();
    assert.equal(
      latestLockLabeledAtMs(
        [{ event: 'labeled', label: { name: LOCK }, created_at: baseIso(now) }],
        LOCK,
      ),
      now,
    );
  });

  await t.test('multiple labeled events (label removed and re-added) ⇒ most recent', () => {
    const now = Date.now();
    // Historic: peer added long ago, user later removed (unlabeled),
    // we just re-added. Want the most recent — that delimits the
    // current cycle.
    assert.equal(
      latestLockLabeledAtMs(
        [
          { event: 'labeled', label: { name: LOCK }, created_at: baseIso(now - 3_600_000) },
          { event: 'unlabeled', label: { name: LOCK }, created_at: baseIso(now - 1_800_000) },
          { event: 'labeled', label: { name: LOCK }, created_at: baseIso(now + 200) },
        ],
        LOCK,
      ),
      now + 200,
    );
  });

  await t.test('ignores other labels at same timestamp', () => {
    const now = Date.now();
    assert.equal(
      latestLockLabeledAtMs(
        [
          { event: 'labeled', label: { name: 'auto-triaged' }, created_at: baseIso(now) },
          { event: 'labeled', label: { name: LOCK }, created_at: baseIso(now - 100) },
        ],
        LOCK,
      ),
      now - 100,
    );
  });

  await t.test('malformed entries are skipped, not crashed on', () => {
    const now = Date.now();
    assert.equal(
      latestLockLabeledAtMs(
        [
          null,
          { event: 'labeled' },
          { event: 'labeled', label: null, created_at: baseIso(now) },
          { event: 'labeled', label: { name: LOCK }, created_at: 'not-a-date' },
          { event: 'labeled', label: { name: LOCK }, created_at: baseIso(now + 100) },
        ],
        LOCK,
      ),
      now + 100,
    );
  });
});

test('hasSuccessMarkerAfter — #1396 fast re-dispatch regression', async (t) => {
  const { hasSuccessMarkerAfter } = await import('./review-dispatch.mjs');
  const MARKER = '<!-- review-dispatch:agent -->';
  const PHRASE = 'Cursor Cloud Agent dispatched';
  const baseIso = (ts) => new Date(ts).toISOString();
  const mkSuccess = (ts) => ({
    body: `${MARKER}\n🚀 **${PHRASE}** (finding)\n- run: r1`,
    created_at: baseIso(ts),
  });

  await t.test(
    'fast re-dispatch: prior-cycle marker inside default tolerance ⇒ FALSE POSITIVE under local-time cutoff',
    () => {
      // Demonstrates the original bug. Without the server-time fix,
      // this is how the leak presented:
      //   - prior cycle posted SUCCESS at T-500ms
      //   - user removed labels and re-applied within ~500ms
      //   - new run captured preAddLabelsAtMs = T
      //   - cutoff = T - 1500 → prior marker (T-500) passes → false match
      const preCall = Date.now();
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [mkSuccess(preCall - 500)],
          sinceMs: preCall,
          // default toleranceMs = 1500
        }),
        true,
        'sanity: with local-time cutoff + default tolerance, a marker 500ms before is matched (the bug)',
      );
    },
  );

  await t.test(
    'fast re-dispatch: prior-cycle marker rejected when cutoff is server-time of new labeled event (#1396 fix)',
    () => {
      // With the fix, main() passes `sinceMs = server_created_at` of our
      // own `labeled` event (which is necessarily AFTER the prior
      // cycle's `unlabeled` event) and `toleranceMs = 0`. Even though
      // the prior marker is only 500ms before our local preAddLabelsAtMs,
      // it is strictly before the server-stamped labeled event ⇒ no match.
      const priorCycleMarkerAtMs = Date.now();
      // Simulate the fix-path inputs: server labeled at T+200, prior
      // marker posted 500ms earlier (which would have leaked under the
      // old local-time + 1500ms tolerance scheme).
      const serverLabeledAtMs = priorCycleMarkerAtMs + 200;
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [mkSuccess(priorCycleMarkerAtMs)],
          sinceMs: serverLabeledAtMs,
          toleranceMs: 0,
        }),
        false,
      );
    },
  );

  await t.test(
    'fast re-dispatch: current-cycle peer marker (after server labeled) still matched with tolerance=0',
    () => {
      // Counterpart to the previous case — the fix must not regress the
      // legitimate peer-success path. Peer's success marker is posted
      // strictly after the labeled event ⇒ still matched even with
      // tolerance disabled.
      const serverLabeledAtMs = Date.now();
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [mkSuccess(serverLabeledAtMs + 50)],
          sinceMs: serverLabeledAtMs,
          toleranceMs: 0,
        }),
        true,
      );
    },
  );
});

// Static-source guard: regardless of how future maintainers refactor
// the helper, both call sites of `dispatchSucceededAlready` in main()
// MUST forward the SAME (re)lock-acquisition timestamp variable (we
// no longer require the literal `preAddLabelsAtMs` here because #1396
// switched the preferred cutoff to a server-time value derived from
// the events fetch). Without scoping, the #1278 regression returns
// (old success marker short-circuits the new run); without using a
// single shared variable, the two call sites can drift apart and one
// of them can re-open the #1396 leak.
test('review-dispatch.mjs dispatchSucceededAlready call sites share a single scoped cutoff (#1278, #1396)', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const src = readFileSync(resolve(import.meta.dirname, 'review-dispatch.mjs'), 'utf-8');

  // Match only invocation sites (preceded by `await`); the function's
  // own declaration is excluded by this anchor. Use [\s\S]+? to span
  // multi-line argument objects.
  const calls = [...src.matchAll(/await\s+dispatchSucceededAlready\s*\(([\s\S]+?)\)/g)];
  // Expected: exactly two call sites in main() — pre-Cursor-call and
  // the catch block.
  assert.equal(
    calls.length,
    2,
    `expected exactly 2 invocations of dispatchSucceededAlready() in main(), got ${calls.length}`,
  );
  const sinceMsValues = new Set();
  for (const m of calls) {
    const sinceMatch = m[1].match(/sinceMs\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)/);
    assert.ok(
      sinceMatch,
      `dispatchSucceededAlready call site must pass { sinceMs: <identifier>, ... } — required by #1278/#1396; offending call: ${m[0]}`,
    );
    sinceMsValues.add(sinceMatch[1]);
  }
  assert.equal(
    sinceMsValues.size,
    1,
    `both dispatchSucceededAlready call sites must forward the SAME sinceMs variable — required by #1278/#1396; saw: ${[...sinceMsValues].join(', ')}`,
  );

  // #1396: main() must derive the cutoff from the events fetch's
  // server-stamped labeled event timestamp (preferred path), not just
  // the local preAddLabelsAtMs. Lock the helper invocation in source.
  assert.match(
    src,
    /latestLockLabeledAtMs\s*\(\s*events\s*,\s*LOCK_LABEL\s*\)/,
    'main() must derive the peer-success cutoff via latestLockLabeledAtMs(events, LOCK_LABEL) — required by #1396 (avoids fast-re-dispatch leak).',
  );
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
});

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

  await t.test(
    're-dispatch with events-API lag: prior labeled + unlabeled visible, our new labeled NOT yet propagated ⇒ win (#1408)',
    () => {
      // The legitimate re-dispatch flow: user did the documented
      // `dispatched` + `cursor:dispatch` remove → re-apply
      // `cursor:dispatch` dance. Our run just called addLabels, but the
      // GitHub issue events API is lagging and the events list still
      // contains ONLY the prior cycle's `labeled` + `unlabeled` pair.
      //
      // Old buggy behaviour: `Math.max(...labeled.created_at)` surfaces
      // the prior cycle's `labeled` (hours/days ago), which is far older
      // than preAddLabelsAtMs - toleranceMs ⇒ wrongly returns false,
      // we exit without spawning Cursor (issue #1408).
      //
      // Correct behaviour: detect that the most-recent event for the
      // lock label is `unlabeled` (the prior cycle was already wound
      // down), treat as propagation lag, return true.
      const preCall = Date.now();
      assert.equal(
        didWeAcquireDispatchLock({
          events: [
            { event: 'labeled', label: { name: LOCK }, created_at: baseIso(preCall - 3_600_000) },
            { event: 'unlabeled', label: { name: LOCK }, created_at: baseIso(preCall - 60_000) },
            // Note: our new `labeled` event from this run is intentionally
            // absent — that's the events-API lag scenario.
          ],
          lockLabel: LOCK,
          preAddLabelsAtMs: preCall,
        }),
        true,
      );
    },
  );

  await t.test(
    're-dispatch with full propagation: prior labeled + unlabeled + our new labeled visible ⇒ win',
    () => {
      // Same scenario as the #1408 lag case, but the events API has caught
      // up and our new `labeled` event is now visible. Most-recent event
      // is our own labeled (after preAddLabelsAtMs) ⇒ win.
      const preCall = Date.now();
      assert.equal(
        didWeAcquireDispatchLock({
          events: [
            { event: 'labeled', label: { name: LOCK }, created_at: baseIso(preCall - 3_600_000) },
            { event: 'unlabeled', label: { name: LOCK }, created_at: baseIso(preCall - 60_000) },
            { event: 'labeled', label: { name: LOCK }, created_at: baseIso(preCall + 250) },
          ],
          lockLabel: LOCK,
          preAddLabelsAtMs: preCall,
        }),
        true,
      );
    },
  );

  await t.test(
    'legacy lock add long ago, never removed (no unlabeled) ⇒ peer beat us, lose',
    () => {
      // Sanity check: when there's an old `labeled` and NO subsequent
      // `unlabeled`, the lock is still held by whoever added it. That's
      // a real peer-race loss — the #1408 fallback must NOT swallow it.
      const preCall = Date.now();
      assert.equal(
        didWeAcquireDispatchLock({
          events: [
            { event: 'labeled', label: { name: LOCK }, created_at: baseIso(preCall - 3_600_000) },
          ],
          lockLabel: LOCK,
          preAddLabelsAtMs: preCall,
        }),
        false,
      );
    },
  );

  await t.test(
    'unlabeled-then-labeled before us (peer removed + re-added before we ran) ⇒ peer holds lock, lose',
    () => {
      // Edge case: a peer ran the same re-dispatch dance ahead of us and
      // re-added the lock at preCall - 60s. The most-recent event for
      // the lock is `labeled` (not `unlabeled`), older than our pre-call
      // timestamp by well over the tolerance ⇒ peer holds the lock.
      const preCall = Date.now();
      assert.equal(
        didWeAcquireDispatchLock({
          events: [
            { event: 'labeled', label: { name: LOCK }, created_at: baseIso(preCall - 3_600_000) },
            { event: 'unlabeled', label: { name: LOCK }, created_at: baseIso(preCall - 1_800_000) },
            { event: 'labeled', label: { name: LOCK }, created_at: baseIso(preCall - 60_000) },
          ],
          lockLabel: LOCK,
          preAddLabelsAtMs: preCall,
        }),
        false,
      );
    },
  );

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

  // -------------------------------------------------------------------
  // #1457 — events-API propagation lag with stale `unlabeled` visible
  // -------------------------------------------------------------------
  //
  // Scenario: a prior dispatch cycle completed (labeled → unlabeled), a
  // peer just called `addLabels([LOCK_LABEL])` but the new `labeled`
  // event hasn't propagated through GitHub's events API yet. We then
  // call `addLabels` (idempotent — label already set, no new event
  // generated for us either). Our events snapshot shows only the prior
  // cycle's history whose MOST RECENT lock-label event is the
  // `unlabeled`. The legacy labeled-only logic ignored `unlabeled`,
  // saw an empty / fully-stale `lockedTimestamps`, hit the propagation-
  // lag fallback, and returned `true` — spawning a duplicate Cursor
  // agent. Helper must now return `false` in this case (caller retries
  // events fetch to absorb propagation lag before giving up).

  await t.test(
    'most recent visible lock event is `unlabeled` (peer addLabels in flight) ⇒ lose conservatively (#1457)',
    () => {
      const preCall = Date.now();
      assert.equal(
        didWeAcquireDispatchLock({
          events: [
            // Prior cycle: peer labeled, then user/system unlabeled.
            { event: 'labeled', label: { name: LOCK }, created_at: baseIso(preCall - 3_600_000) },
            { event: 'unlabeled', label: { name: LOCK }, created_at: baseIso(preCall - 60_000) },
            // Peer's just-now `addLabels` not yet surfaced; our own
            // call was idempotent (label already set) so no fresh
            // labeled event from us either.
          ],
          lockLabel: LOCK,
          preAddLabelsAtMs: preCall,
        }),
        false,
      );
    },
  );

  await t.test(
    'only `unlabeled` visible for the lock (no labeled at all) ⇒ lose conservatively (#1457)',
    () => {
      // Defensive corner: pagination dropped the older labeled event but
      // the unlabeled survived. With nothing to anchor a labeled
      // timestamp to and a visible unlabeled, treat as ambiguous → lose.
      const preCall = Date.now();
      assert.equal(
        didWeAcquireDispatchLock({
          events: [
            { event: 'unlabeled', label: { name: LOCK }, created_at: baseIso(preCall - 60_000) },
          ],
          lockLabel: LOCK,
          preAddLabelsAtMs: preCall,
        }),
        false,
      );
    },
  );

  await t.test(
    'unlabeled then fresh labeled (events refetch caught up) ⇒ decide on labeled timestamp (#1457)',
    () => {
      // After the caller's retry fetch, the missing labeled event has
      // surfaced. Helper must fall through to the normal labeled-time
      // comparison instead of staying stuck on the unlabeled signal.
      const preCall = Date.now();
      assert.equal(
        didWeAcquireDispatchLock({
          events: [
            { event: 'labeled', label: { name: LOCK }, created_at: baseIso(preCall - 3_600_000) },
            { event: 'unlabeled', label: { name: LOCK }, created_at: baseIso(preCall - 60_000) },
            { event: 'labeled', label: { name: LOCK }, created_at: baseIso(preCall + 200) },
          ],
          lockLabel: LOCK,
          preAddLabelsAtMs: preCall,
        }),
        true,
      );
    },
  );

  await t.test(
    'unlabeled then peer labeled well before pre-call ts ⇒ lose (normal labeled-time loss preserved)',
    () => {
      // Counterpart to the case above: after the retry the labeled
      // event surfaced, but it predates our addLabels by enough that
      // the labeled-time comparison correctly rules it as the peer's.
      const preCall = Date.now();
      assert.equal(
        didWeAcquireDispatchLock({
          events: [
            { event: 'unlabeled', label: { name: LOCK }, created_at: baseIso(preCall - 120_000) },
            { event: 'labeled', label: { name: LOCK }, created_at: baseIso(preCall - 30_000) },
          ],
          lockLabel: LOCK,
          preAddLabelsAtMs: preCall,
        }),
        false,
      );
    },
  );

  await t.test(
    'only `unlabeled` events for OTHER labels (non-lock) ⇒ still win (defensive — unrelated history)',
    () => {
      // Sanity: the unlabeled-guard must be scoped to the lock label.
      // Unrelated labels removing/adding must not affect the decision.
      const preCall = Date.now();
      assert.equal(
        didWeAcquireDispatchLock({
          events: [
            { event: 'unlabeled', label: { name: 'review-finding' }, created_at: baseIso(preCall - 60_000) },
            { event: 'labeled', label: { name: 'auto-triaged' }, created_at: baseIso(preCall - 30_000) },
          ],
          lockLabel: LOCK,
          preAddLabelsAtMs: preCall,
        }),
        true,
      );
    },
  );
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
  const mkSuccess = (ts, user = { login: 'github-actions[bot]', type: 'Bot' }) => ({
    body: `${MARKER}\n🚀 **${PHRASE}** (finding)\n- run: r1`,
    created_at: baseIso(ts),
    user,
  });
  const mkRaceSkip = (ts, user = { login: 'github-actions[bot]', type: 'Bot' }) => ({
    // Real comment shape from main() when the events-API race check
    // detected a peer winning: same MARKER, no SUCCESS phrase.
    body: `${MARKER}\n\n⚠ 检测到并发 dispatch 竞态：另一次 run 已先获取 \`dispatched\` 锁。`,
    created_at: baseIso(ts),
    user,
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
    // GitHub server clock 100ms behind local — still treated as current
    // cycle by the local-clock fallback's default toleranceMs (250 ms
    // after #1330; previously 1500 ms — see hasSuccessMarkerAfter
    // jsdoc for rationale on the tightened default).
    assert.equal(
      hasSuccessMarkerAfter({ comments: [mkSuccess(since - 100)], sinceMs: since }),
      true,
    );
  });

  await t.test(
    'peer marker 1.4s before sinceMs ⇒ NO match under tightened default (#1330)',
    () => {
      // Regression guard for #1330: the previous 1500ms default would
      // misclassify a prior-cycle success marker posted up to 1.5s
      // before our pre-lock timestamp as the current peer's success,
      // silently skipping the Cursor call on a fast re-dispatch.
      // Tight 250ms default closes that window. Caller can still opt
      // into a wider tolerance explicitly if they need it.
      const since = Date.now();
      assert.equal(
        hasSuccessMarkerAfter({ comments: [mkSuccess(since - 1400)], sinceMs: since }),
        false,
      );
    },
  );

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

  // -------------------------------------------------------------------
  // cutoffServerMs path — added by #1330
  // -------------------------------------------------------------------
  //
  // When the issue events fetch in main() succeeded we anchor the
  // cutoff to the GitHub server timestamp of the most recent
  // `labeled` LOCK_LABEL event (see latestLockLabeledServerTs). Both
  // the anchor and each marker's `created_at` are server-stamped, so
  // the cutoff comparison has no clock-skew gap and we don't need
  // the tolerance fudge factor that otherwise leaks stale markers
  // from a prior cycle.

  await t.test(
    'cutoffServerMs anchor is used directly without tolerance fudge (#1330)',
    () => {
      // Prior cycle's marker is 1.4s before our LOCK_LABEL labeled
      // event. Under the local-clock fallback's old 1500ms tolerance
      // this leaked through and looked like a current peer's success;
      // under the new server-side anchor it's strictly before the
      // cycle's lock-acquisition timestamp, so it's correctly rejected.
      const cutoff = Date.now();
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [mkSuccess(cutoff - 1400)],
          cutoffServerMs: cutoff,
          // Also pass sinceMs to confirm server anchor takes precedence
          // (under the previous local-clock policy with default 1500ms
          // tolerance, this same marker would have matched).
          sinceMs: cutoff,
          toleranceMs: 1500,
        }),
        false,
      );
    },
  );

  await t.test(
    'cutoffServerMs: peer marker strictly after anchor ⇒ match; at anchor ⇒ no match (#1383)',
    () => {
      // Strict-after semantic — see hasSuccessMarkerAfter jsdoc cutoff
      // path #1. GitHub timestamps are second-precision so a marker
      // bucketed to the same second as the cycle's `labeled` event is
      // necessarily from a PRIOR cycle (the user must remove
      // `dispatched` between cycles, generating an `unlabeled` event
      // in between, so a current-cycle peer marker is always at least
      // one server-bucketed second after the cycle's labeled event).
      const cutoff = Date.now();
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [mkSuccess(cutoff)],
          cutoffServerMs: cutoff,
        }),
        false,
      );
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [mkSuccess(cutoff + 1)],
          cutoffServerMs: cutoff,
        }),
        true,
      );
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [mkSuccess(cutoff + 5)],
          cutoffServerMs: cutoff,
        }),
        true,
      );
    },
  );

  await t.test(
    'cutoffServerMs: same-second OLD marker (server-bucketed equality) ⇒ rejected (#1383)',
    () => {
      // Realistic regression guard for #1383. GitHub stamps both the
      // `labeled` event's `created_at` and each comment's `created_at`
      // to whole seconds (ISO 8601 with no millis). When a fast
      // re-dispatch lands the new cycle's `labeled` event in the SAME
      // wall-clock second as a still-on-the-issue OLD success marker
      // from a prior cycle, both parse to identical ms after
      // `new Date(...).getTime()`. The previous `ts >= cutoffServerMs`
      // comparison classified that as a current peer's success — pre-
      // call site silently skipped Cursor, catch-block site refused to
      // release the lock. Strict-after semantic catches it.
      const isoSecond = '2026-05-26T14:35:50Z'; // both stamped to the same second
      const cutoffServerMs = new Date(isoSecond).getTime();
      const oldMarker = {
        body: `${MARKER}\n🚀 **${PHRASE}** (finding)\n- run: r-old`,
        created_at: isoSecond,
      };
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [oldMarker],
          cutoffServerMs,
        }),
        false,
      );
      // Sanity: a marker stamped to the NEXT second is correctly accepted.
      const peerMarker = {
        body: `${MARKER}\n🚀 **${PHRASE}** (finding)\n- run: r-peer`,
        created_at: '2026-05-26T14:35:51Z',
      };
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [peerMarker],
          cutoffServerMs,
        }),
        true,
      );
    },
  );
  await t.test('cutoffServerMs: peer marker at or after anchor ⇒ match', () => {
    const cutoff = Date.now();
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [mkSuccess(cutoff)],
        cutoffServerMs: cutoff,
      }),
      true,
    );
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [mkSuccess(cutoff + 5)],
        cutoffServerMs: cutoff,
      }),
      true,
    );
  });

  await t.test('cutoffServerMs takes precedence over sinceMs when both supplied', () => {
    const t0 = Date.now();
    // Server anchor says cycle started at t0; marker is just before.
    // Server cutoff path: marker.ts < anchor ⇒ reject.
    // Local fallback (sinceMs only) with default 250ms tolerance:
    // marker.ts = anchor - 5 is >= sinceMs - 250 ⇒ would have matched.
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [mkSuccess(t0 - 5)],
        cutoffServerMs: t0,
        sinceMs: t0,
  // ------------------------------------------------------------------
  // Trusted-author filtering — #1384
  // ------------------------------------------------------------------
  // Comment body is fully user-controllable; without an author filter,
  // anyone with comment access on the issue could post a comment
  // carrying the marker + success phrase and:
  //   (a) at the pre-Cursor-call site, trick the dispatcher into
  //       skipping the API call (no agent ever starts), or
  //   (b) in the catch block, trick the dispatcher into NOT releasing
  //       the lock label (re-dispatch is blocked).
  // The trusted-author list pins the comment author to the workflow's
  // own bot identity (`github-actions[bot]`, type `Bot`).
  await t.test('forged marker from untrusted user ⇒ ignored (#1384)', () => {
    const since = Date.now();
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [mkSuccess(since + 100, { login: 'attacker', type: 'User' })],
        sinceMs: since,
        trustedAuthors: ['github-actions[bot]'],
      }),
      false,
      'a User-type author must never be trusted even if login matches a bot string',
    );
  });

  await t.test('forged marker from other bot ⇒ ignored (#1384)', () => {
    const since = Date.now();
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [mkSuccess(since + 100, { login: 'dependabot[bot]', type: 'Bot' })],
        sinceMs: since,
        trustedAuthors: ['github-actions[bot]'],
      }),
      false,
      'only the workflow GITHUB_TOKEN identity should be trusted',
    );
  });

  await t.test(
    'login matches but user.type is not Bot ⇒ ignored (#1384)',
    () => {
      const since = Date.now();
      // Defensive: a future GitHub API change that lets a non-Bot user
      // claim the `github-actions[bot]` login should still not pass.
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [
            mkSuccess(since + 100, { login: 'github-actions[bot]', type: 'User' }),
          ],
          sinceMs: since,
          trustedAuthors: ['github-actions[bot]'],
        }),
        false,
      );
    },
  );

  await t.test('missing user object ⇒ ignored when trustedAuthors set (#1384)', () => {
    const since = Date.now();
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [
          { body: `${MARKER} ${PHRASE}`, created_at: baseIso(since + 100) },
        ],
        sinceMs: since,
        trustedAuthors: ['github-actions[bot]'],
  // ---- #1407: rapid re-dispatch within tolerance window --------------
  //
  // The `sinceMs - toleranceMs` clock-skew cutoff isn't enough on its
  // own. If the user removes `dispatched` + `cursor:dispatch` and re-
  // applies `cursor:dispatch` within `toleranceMs` (1500 ms by default)
  // of the prior cycle's success-marker comment, the new run captures
  // a `preAddLabelsAtMs` that, after tolerance subtraction, falls
  // BEFORE the old marker — so the old marker matches again and the
  // new run silently skips Cursor. Adding `notBeforeMs` (anchored at
  // the current cycle's GitHub-stamped `labeled LOCK_LABEL` event)
  // closes that hole without weakening the clock-skew tolerance.
  await t.test('rapid re-dispatch within tolerance: notBeforeMs rejects stale marker', () => {
    const oldSuccess = Date.now() - 200; // prior cycle's marker
    const lockReacquired = oldSuccess + 100; // current cycle's labeled event (after marker)
    const since = lockReacquired + 50; // local clock at our addLabels (≈now)
    // Without notBeforeMs the old marker would slip through: since - 1500 = oldSuccess - 1350 < oldSuccess.
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [mkSuccess(oldSuccess)],
        sinceMs: since,
        notBeforeMs: lockReacquired,
      }),
      false,
    );
  });
});

// ---------------------------------------------------------------------
// latestLockLabeledServerTs — server-side cutoff source for #1330
// ---------------------------------------------------------------------
test('latestLockLabeledServerTs', async (t) => {
  const { latestLockLabeledServerTs } = await import('./review-dispatch.mjs');
  const LOCK = 'dispatched';
  const baseIso = (ts) => new Date(ts).toISOString();

  await t.test('picks the MOST RECENT labeled event for the lock', () => {
    const t0 = Date.now();
    const ts = latestLockLabeledServerTs({
      events: [
        { event: 'labeled', label: { name: LOCK }, created_at: baseIso(t0 - 3_600_000) },
        { event: 'unlabeled', label: { name: LOCK }, created_at: baseIso(t0 - 1_800_000) },
        { event: 'labeled', label: { name: LOCK }, created_at: baseIso(t0 - 100) },
      ],
      lockLabel: LOCK,
    });
    assert.equal(ts, t0 - 100);
  });

  await t.test('ignores labeled events for other labels', () => {
    const t0 = Date.now();
    assert.equal(
      latestLockLabeledServerTs({
        events: [
          { event: 'labeled', label: { name: 'review-finding' }, created_at: baseIso(t0) },
          { event: 'labeled', label: { name: 'auto-triaged' }, created_at: baseIso(t0 + 10) },
        ],
        lockLabel: LOCK,
      }),
      null,
    );
  });

  await t.test('returns null on empty / missing events', () => {
    assert.equal(latestLockLabeledServerTs({ events: [], lockLabel: LOCK }), null);
    assert.equal(latestLockLabeledServerTs({ lockLabel: LOCK }), null);
    assert.equal(latestLockLabeledServerTs(), null);
  });

  await t.test('returns null when lockLabel is not provided', () => {
    const t0 = Date.now();
    assert.equal(
      latestLockLabeledServerTs({
        events: [{ event: 'labeled', label: { name: LOCK }, created_at: baseIso(t0) }],
      }),
      null,
    );
  });

  await t.test('skips malformed entries without crashing', () => {
    const t0 = Date.now();
    assert.equal(
      latestLockLabeledServerTs({
        events: [
          null,
          { event: 'labeled' },
          { event: 'labeled', label: null, created_at: baseIso(t0) },
          { event: 'labeled', label: { name: LOCK }, created_at: 'not-a-date' },
          { event: 'labeled', label: { name: LOCK }, created_at: baseIso(t0 + 50) },
        ],
        lockLabel: LOCK,
      }),
      t0 + 50,

  await t.test('notBeforeMs still admits a peer marker from the current cycle', () => {
    const lockReacquired = Date.now() - 100;
    const peerSuccess = lockReacquired + 80; // peer posted after the current cycle's lock event
    const since = lockReacquired + 10;
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [mkSuccess(peerSuccess)],
        sinceMs: since,
        notBeforeMs: lockReacquired,
      }),
      true,
    );
  });

  await t.test('notBeforeMs without sinceMs acts as the sole cutoff', () => {
    const cycleStart = Date.now();
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [mkSuccess(cycleStart - 1000)],
        notBeforeMs: cycleStart,
      }),
      false,
    );
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [mkSuccess(cycleStart + 1000)],
        notBeforeMs: cycleStart,
      }),
      true,
    );
  });

  await t.test('notBeforeMs LOWER than sinceMs - tolerance is a no-op (tolerance wins)', () => {
    // notBeforeMs only tightens the window; it never widens it.
    const since = Date.now();
    const peerWithinSkew = since - 500;
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [mkSuccess(peerWithinSkew)],
        sinceMs: since,
        notBeforeMs: since - 60_000, // way back
      }),
      true,
    );
  });
});

// ---------------------------------------------------------------------
// review-dispatch.mjs latestLockLabeledAtMs — #1407
// ---------------------------------------------------------------------
//
// Returns the GitHub-stamped epoch-ms of the most recent `labeled
// LOCK_LABEL` event, i.e. when the current dispatch cycle's lock was
// acquired on GitHub's clock. Used to anchor hasSuccessMarkerAfter's
// `notBeforeMs` so the tolerance window can't reach back into a prior
// cycle during a rapid re-dispatch.
test('latestLockLabeledAtMs', async (t) => {
  const { latestLockLabeledAtMs } = await import('./review-dispatch.mjs');
  const LOCK = 'dispatched';
  const baseIso = (ts) => new Date(ts).toISOString();

  await t.test('no events ⇒ null', () => {
    // #1604: use positional args (events, lockLabel) to match the production signature
    assert.equal(latestLockLabeledAtMs([], LOCK), null);
    assert.equal(latestLockLabeledAtMs(null, LOCK), null);
    assert.equal(latestLockLabeledAtMs(), null);
  });

  await t.test('missing lockLabel ⇒ null', () => {
    assert.equal(
      latestLockLabeledAtMs(
        [{ event: 'labeled', label: { name: LOCK }, created_at: baseIso(Date.now()) }],
      ),
      null,
    );
  });

  await t.test('returns latest labeled-event timestamp for the lock label', () => {
    const t1 = Date.now() - 60_000;
    const t2 = Date.now() - 10_000;
    assert.equal(
      latestLockLabeledAtMs(
        [
          { event: 'labeled', label: { name: LOCK }, created_at: baseIso(t1) },
          { event: 'unlabeled', label: { name: LOCK }, created_at: baseIso(t1 + 5_000) },
          { event: 'labeled', label: { name: LOCK }, created_at: baseIso(t2) },
        ],
        LOCK,
      ),
      t2,
    );
  });

  await t.test('ignores events for other labels and non-labeled events', () => {
    const t1 = Date.now() - 5_000;
    assert.equal(
      latestLockLabeledAtMs(
        [
          { event: 'labeled', label: { name: 'cursor:dispatch' }, created_at: baseIso(Date.now()) },
          { event: 'commented', created_at: baseIso(Date.now()) },
          { event: 'labeled', label: { name: LOCK }, created_at: baseIso(t1) },
        ],
        LOCK,
      ),
      t1,
    );
  });

  await t.test('malformed entries are skipped', () => {
    const ts = Date.now() - 2_000;
    assert.equal(
      latestLockLabeledAtMs(
        [
          null,
          { event: 'labeled' },
          { event: 'labeled', label: null, created_at: baseIso(Date.now()) },
          { event: 'labeled', label: { name: LOCK }, created_at: 'not-a-date' },
          { event: 'labeled', label: { name: LOCK }, created_at: baseIso(ts) },
        ],
        LOCK,
      ),
      ts,
    );
  });

  await t.test('legit marker from github-actions[bot] ⇒ match (#1384)', () => {
    const since = Date.now();
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [mkSuccess(since + 200)],
        sinceMs: since,
        trustedAuthors: ['github-actions[bot]'],
      }),
      true,
    );
  });

  await t.test(
    'forged + legit comments together ⇒ legit one still wins (#1384)',
    () => {
      const since = Date.now();
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [
            mkSuccess(since + 100, { login: 'attacker', type: 'User' }),
            mkSuccess(since + 200),
          ],
          sinceMs: since,
          trustedAuthors: ['github-actions[bot]'],
        }),
        true,
      );
    },
  );

  await t.test(
    'empty trustedAuthors list ⇒ filter skipped (back-compat)',
    () => {
      const since = Date.now();
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [mkSuccess(since + 100, { login: 'attacker', type: 'User' })],
          sinceMs: since,
          trustedAuthors: [],
        }),
        true,
      );
    },
  );
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

// ---------------------------------------------------------------------
// review-dispatch.mjs same-second prior-cycle leak — #1461
// ---------------------------------------------------------------------
//
// #1396 wired the server-stamped `labeled` LOCK event's `created_at`
// into the peer-success cutoff with `toleranceMs: 0`, which is correct
// to millisecond precision. But GitHub's `created_at` field is
// truncated to whole seconds (ISO 8601, no sub-second component), so
// `new Date(...).getTime()` always returns a multiple of 1000 ms. If
// the prior cycle's success marker was posted in the SAME wall-clock
// second as the new cycle's `labeled` event, the two parsed timestamps
// collide exactly and the inclusive `ts >= cutoff` comparison leaks
// the stale marker into the new cycle — exactly the fast-re-dispatch
// regression #1461 reports. The fix introduces a strict-after
// `notBeforeMs` cutoff for server-anchored callers.
test('hasSuccessMarkerAfter — #1461 notBeforeMs strict-after semantics', async (t) => {
  const { hasSuccessMarkerAfter } = await import('./review-dispatch.mjs');
  const MARKER = '<!-- review-dispatch:agent -->';
  const PHRASE = 'Cursor Cloud Agent dispatched';
  const baseIso = (ts) => new Date(ts).toISOString();
  const mkSuccess = (ts) => ({
    body: `${MARKER}\n🚀 **${PHRASE}** (finding)\n- run: r1`,
    created_at: baseIso(ts),
  });

  await t.test('marker AT notBeforeMs ⇒ no match (strict >, not >=)', () => {
    const t0 = 1_700_000_000_000;
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [mkSuccess(t0)],
        notBeforeMs: t0,
      }),
      false,
    );
  });

  await t.test('marker strictly after notBeforeMs ⇒ match', () => {
    const t0 = 1_700_000_000_000;
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [mkSuccess(t0 + 1)],
        notBeforeMs: t0,
      }),
      true,
    );
  });

  await t.test('marker before notBeforeMs ⇒ no match', () => {
    const t0 = 1_700_000_000_000;
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [mkSuccess(t0 - 1000)],
        notBeforeMs: t0,
      }),
      false,
    );
  });

  await t.test(
    'same wall-clock second: prior-cycle ISO timestamp == lock event ISO timestamp ⇒ no match (#1461)',
    () => {
      // Realistic shape: GitHub returns ISO strings with second precision.
      // Both timestamps fall in the same wall-clock second but the LABELED
      // event happened later in real time (after the user removed labels
      // and re-applied `cursor:dispatch`). Without the strict-after fix,
      // `ts >= cutoff` would let the OLD cycle's marker through.
      const sameSecondIso = '2026-05-27T12:34:56Z';
      const lockEventMs = new Date(sameSecondIso).getTime();
      const priorMarker = {
        body: `${MARKER}\n🚀 **${PHRASE}** (finding)\n- run: prev`,
        created_at: sameSecondIso,
      };
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [priorMarker],
          notBeforeMs: lockEventMs,
        }),
        false,
        'prior-cycle marker bucketed to the same wall-clock second as the labeled LOCK event must NOT be classified as a current peer success',
      );
    },
  );

  await t.test(
    'genuine current-cycle peer success (next second) ⇒ still matches under notBeforeMs',
    () => {
      // Counterpart to the regression case: peer's own success marker
      // posted ≥1 second after the labeled event must continue to be
      // detected, otherwise the belt-and-suspenders peer-race guard
      // collapses.
      const lockSecondIso = '2026-05-27T12:34:56Z';
      const peerSuccessIso = '2026-05-27T12:34:57Z';
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [
            {
              body: `${MARKER}\n🚀 **${PHRASE}** (finding)\n- run: peer`,
              created_at: peerSuccessIso,
            },
          ],
          notBeforeMs: new Date(lockSecondIso).getTime(),
        }),
        true,
      );
    },
  );

  await t.test('malformed timestamp ⇒ skipped under notBeforeMs', () => {
    const t0 = Date.now();
    assert.equal(
      hasSuccessMarkerAfter({
        comments: [
          {
            body: `${MARKER} ${PHRASE}`,
            created_at: 'not-a-date',
          },
        ],
        notBeforeMs: t0,
      }),
      false,
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
// MUST forward the SAME single cutoff argument (a variable identifier
// pointing at the same `peerSuccessCutoff` derivation). Without scoping
// the #1278 regression returns (old success marker short-circuits the
// new run); without sharing a single variable, the two call sites can
// drift apart and one of them can re-open the #1396 / #1461 leak.
test('review-dispatch.mjs dispatchSucceededAlready call sites share a single scoped cutoff (#1278, #1396, #1461)', async () => {
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
  const argIdentifiers = new Set();
  for (const m of calls) {
    // Both call sites must pass a single bare identifier (the shared
    // `peerSuccessCutoff` object). Reject inline-object literals so the
    // two call sites cannot drift apart in future edits.
    const argMatch = m[1].trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
    assert.ok(
      argMatch,
      `dispatchSucceededAlready call site must pass a single identifier (the shared peerSuccessCutoff variable) — required by #1278/#1396/#1461; offending call: ${m[0]}`,
    );
    argIdentifiers.add(argMatch[1]);
    sinceMsValues.add(sinceMatch[1]);
    // #1407: also forward `events` so the helper can anchor a GitHub-
    // clock `notBeforeMs` lower bound and reject stale prior-cycle
    // markers that would otherwise fall inside the tolerance window
    // after a rapid re-dispatch.
    assert.match(
      m[1],
      /\bevents\b/,
      `dispatchSucceededAlready call site must forward \`events\` — required by #1407; offending call: ${m[0]}`,
    );
  }
  assert.equal(
    argIdentifiers.size,
    1,
    `both dispatchSucceededAlready call sites must forward the SAME cutoff variable — required by #1278/#1396/#1461; saw: ${[...argIdentifiers].join(', ')}`,
  );

  // #1396: main() must derive the cutoff from the events fetch's
  // server-stamped labeled event timestamp (preferred path), not just
  // the local preAddLabelsAtMs. Lock the helper invocation in source.
  assert.match(
    src,
    /latestLockLabeledAtMs\s*\(\s*events\s*,\s*LOCK_LABEL\s*\)/,
    'main() must derive the peer-success cutoff via latestLockLabeledAtMs(events, LOCK_LABEL) — required by #1396 (avoids fast-re-dispatch leak).',
  );

  // #1461: the server-anchored path must use STRICT-AFTER (`notBeforeMs`)
  // semantics, not the inclusive `sinceMs - toleranceMs` form. GitHub's
  // `created_at` is at second-level precision, so `>=` against a
  // same-wall-clock-second prior-cycle marker would let it leak in.
  // Lock that the cutoff object built from `serverLockedAtMs` populates
  // `notBeforeMs` (and not `sinceMs`).
  assert.match(
    src,
    /serverLockedAtMs\s*!==\s*null\s*\?\s*\{\s*notBeforeMs\s*:/,
    'server-anchored peer-success cutoff must use { notBeforeMs: ... } (strict-after) — required by #1461 (same-second prior-cycle marker leak).',
  );
});
// MUST forward `sinceMs: preAddLabelsAtMs` AND `cutoffServerMs`. The
// `sinceMs` arg is the local-clock fallback (#1278): without it, an
// OLD success marker from a prior re-dispatch cycle would short-circuit
// the new run before Cursor is called (pre-call site) or block the
// lock release on failure (catch site). The `cutoffServerMs` arg is
// the server-side anchor (#1330): without it, the local-clock
// fallback's residual tolerance window still leaks stale markers
// posted shortly before our pre-lock timestamp. Lock both contracts
// in source so a "simplify the call sites" drive-by can't silently
// re-introduce either bug.
//
// `cutoffServerMs` must be derivable in scope — main() computes it
// from the events list it already fetched for the race-detection
// check (it can be `null` when the events fetch failed; the helper
// then degrades to the local-clock path).
test(
  'review-dispatch.mjs dispatchSucceededAlready call sites scope by preAddLabelsAtMs (#1278) and pass server-side anchor (#1330)',
  async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(import.meta.dirname, 'review-dispatch.mjs'), 'utf-8');

    // Match only invocation sites (preceded by `await`); the function's
    // own declaration is excluded by this anchor. Use a balanced
    // matcher tolerant of newlines / multi-line option objects, since
    // the call sites are now multi-line.
    const calls = [...src.matchAll(/await\s+dispatchSucceededAlready\s*\(([^)]*)\)/g)];
    // Expected: exactly two call sites in main() — pre-Cursor-call and
    // the catch block.
    assert.equal(
      calls.length,
      2,
      `expected exactly 2 invocations of dispatchSucceededAlready() in main(), got ${calls.length}`,
    );
    for (const m of calls) {
      assert.match(
        m[1],
        /sinceMs\s*:\s*preAddLabelsAtMs/,
        `dispatchSucceededAlready call site must pass { sinceMs: preAddLabelsAtMs } — required by #1278; offending call: ${m[0]}`,
      );
      assert.match(
        m[1],
        /cutoffServerMs/,
        `dispatchSucceededAlready call site must also pass { cutoffServerMs } (the server-side cutoff anchor) — required by #1330; offending call: ${m[0]}`,
      );
    }

    // main() must derive the anchor from the already-fetched events
    // list via latestLockLabeledServerTs. Lock the wiring so future
    // refactors don't accidentally drop the events-driven path back
    // to the local-clock fallback.
    assert.match(
      src,
      /latestLockLabeledServerTs\s*\(\s*\{[\s\S]*?lockLabel:\s*LOCK_LABEL/m,
      'main() must invoke latestLockLabeledServerTs({ events, lockLabel: LOCK_LABEL }) to derive cutoffServerMs — required by #1330.',
    );
  },
);

// Static-source guard: dispatchSucceededAlready() MUST forward a
// non-empty `trustedAuthors` list when invoking hasSuccessMarkerAfter,
// otherwise the comment-body filter degrades to its pre-#1384 shape
// (anyone with comment access can forge a success marker to either
// skip Cursor at the pre-call site or block lock release in the
// catch). Lock the wiring in source so a drive-by refactor can't
// silently re-introduce the vulnerability.
test('review-dispatch.mjs dispatchSucceededAlready forwards trustedAuthors to hasSuccessMarkerAfter (#1384)', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const src = readFileSync(resolve(import.meta.dirname, 'review-dispatch.mjs'), 'utf-8');

  // Locate the function body and assert it threads `trustedAuthors:`
  // into the hasSuccessMarkerAfter call. Matching the call argument
  // shape directly (not the function declaration) is what guards the
  // wiring — the constant could be renamed but the keyword arg must
  // stay.
  const fnMatch = src.match(/async function dispatchSucceededAlready[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'expected dispatchSucceededAlready() declaration in review-dispatch.mjs');
  assert.match(
    fnMatch[0],
    /hasSuccessMarkerAfter\s*\(\s*\{[\s\S]*?trustedAuthors\s*:/,
    'dispatchSucceededAlready must pass `trustedAuthors:` into hasSuccessMarkerAfter — required by #1384 (without it, anyone with comment access on the issue can forge a marker and bypass dispatch).',
  );

  // And the trusted list must actually contain the workflow's bot
  // identity. We don't pin the exact spelling of the constant name,
  // but the literal `github-actions[bot]` must appear in the source
  // and must live near the trusted-authors constant.
  assert.match(
    src,
    /['"]github-actions\[bot\]['"]/,
    'review-dispatch.mjs must list `github-actions[bot]` as a trusted comment author (#1384).',
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

  // #1385 propagation-lag fallback: when the events list does not show
  // the just-issued `unlabeled` event (events fetch failed, or GH events
  // API propagation lag), `findLastUnlabeledMs` returns `null`. Earlier
  // shapes assigned that `null` straight through to `cycleStartMs`, which
  // collapsed the sinceMs filter to "no filter" and let stale prior-cycle
  // SUCCESS markers short-circuit the new run — exactly the #1278
  // regression PR #1357 set out to fix. main() MUST route the assignment
  // through `computeCycleStartMs` so the null path falls back to the
  // local-clock `preAddLabelsAtMs - toleranceMs` cutoff.
  assert.match(
    src,
    /const cycleStartMs\s*=\s*computeCycleStartMs\s*\(/,
    'main() must assign `cycleStartMs` via `computeCycleStartMs({ events, lockLabel, preAddLabelsAtMs })` so that the null-from-findLastUnlabeledMs path (events fetch failed, or propagation lag hid the latest unlabeled event) falls back to a local-clock cutoff instead of degrading to "no filter". The previous `events ? findLastUnlabeledMs(...) : null` shape silently re-introduced #1278 in the degraded path — see #1385.',
  );
  assert.ok(
    !/const cycleStartMs\s*=\s*events\s*\?\s*findLastUnlabeledMs\s*\([^)]*\)\s*:\s*null/.test(
      src,
    ),
    '`cycleStartMs` must NOT be assigned with the bare `events ? findLastUnlabeledMs(...) : null` shape — that collapses to "no filter" whenever events are unavailable or lag hides the latest unlabeled event, re-introducing #1278 (#1385). Use `computeCycleStartMs` instead.',
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

// ---------------------------------------------------------------------
// computeCycleStartMs — events-API-propagation-lag fallback (#1385)
// ---------------------------------------------------------------------
//
// PR #1357 wired main()'s `cycleStartMs` as:
//
//     const cycleStartMs = events ? findLastUnlabeledMs({...}) : null;
//
// That shape returns `null` whenever the events list can't show the
// just-issued `unlabeled` event for LOCK_LABEL — either because the
// events fetch failed, or because the GitHub events API hasn't yet
// propagated the user's remove-then-re-add re-dispatch action. In that
// state, `dispatchSucceededAlready({ sinceMs: null })` collapses to
// "any historic marker counts" and a stale prior-cycle SUCCESS marker
// short-circuits the new run — exactly the #1278 regression PR #1357
// claimed to fix. `computeCycleStartMs` keeps the cycle-boundary cutoff
// when events expose it, and otherwise falls back to the local-clock
// `preAddLabelsAtMs - toleranceMs` so #1278 stays fixed even in the
// degraded path.
test('computeCycleStartMs (#1385 propagation-lag fallback)', async (t) => {
  const { computeCycleStartMs } = await import('./review-dispatch.mjs');
  const LOCK = 'dispatched';
  const baseIso = (ts) => new Date(ts).toISOString();

  await t.test('prefers findLastUnlabeledMs when events expose the cycle boundary', () => {
    const now = 1_700_000_000_000;
    const cycleStart = now - 3_600_000;
    const events = [
      { event: 'labeled', label: { name: LOCK }, created_at: baseIso(now - 7_200_000) },
      { event: 'unlabeled', label: { name: LOCK }, created_at: baseIso(cycleStart) },
      { event: 'labeled', label: { name: LOCK }, created_at: baseIso(now - 60_000) },
    ];
    assert.equal(
      computeCycleStartMs({
        events,
        lockLabel: LOCK,
        preAddLabelsAtMs: now,
      }),
      cycleStart,
    );
  });

  await t.test(
    '#1385: events fetch failed (events === null) ⇒ falls back to preAddLabelsAtMs - toleranceMs (not null)',
    () => {
      // Reproduces the documented regression: the previous shape
      // collapsed to `sinceMs: null` here, which made any historic
      // SUCCESS marker (including the prior cycle's) short-circuit
      // the new run.
      const preAddLabelsAtMs = 1_700_000_500_000;
      assert.equal(
        computeCycleStartMs({
          events: null,
          lockLabel: LOCK,
          preAddLabelsAtMs,
        }),
        preAddLabelsAtMs - 1500,
      );
    },
  );

  await t.test(
    '#1385: events fetched but propagation lag hides the latest unlabeled event ⇒ falls back, not null',
    () => {
      // Real-world repro: user did the remove+re-add re-dispatch dance.
      // The just-removed `unlabeled` event for LOCK_LABEL hasn't propagated
      // to the events API yet, so the events list only carries the prior
      // cycle's `labeled` event (and maybe other unrelated events).
      // `findLastUnlabeledMs` returns null. `computeCycleStartMs` MUST NOT
      // pass that null through — it has to fall back to the local-clock
      // cutoff so a stale prior-cycle SUCCESS marker doesn't block this
      // legitimate re-dispatch.
      const preAddLabelsAtMs = 1_700_000_500_000;
      const events = [
        // Prior cycle's labeled event is visible; its matching unlabeled
        // has not propagated yet.
        {
          event: 'labeled',
          label: { name: LOCK },
          created_at: baseIso(preAddLabelsAtMs - 3_600_000),
        },
        // Unrelated unlabeled event that must NOT be confused with the
        // lock's cycle boundary.
        {
          event: 'unlabeled',
          label: { name: 'some-other-label' },
          created_at: baseIso(preAddLabelsAtMs - 1_000),
        },
      ];
      assert.equal(
        computeCycleStartMs({
          events,
          lockLabel: LOCK,
          preAddLabelsAtMs,
        }),
        preAddLabelsAtMs - 1500,
      );
    },
  );

  await t.test('respects custom toleranceMs override', () => {
    const preAddLabelsAtMs = 1_700_000_500_000;
    assert.equal(
      computeCycleStartMs({
        events: null,
        lockLabel: LOCK,
        preAddLabelsAtMs,
        toleranceMs: 5000,
      }),
      preAddLabelsAtMs - 5000,
    );
  });

  await t.test('toleranceMs=0 ⇒ exact preAddLabelsAtMs cutoff', () => {
    const preAddLabelsAtMs = 1_700_000_500_000;
    assert.equal(
      computeCycleStartMs({
        events: null,
        lockLabel: LOCK,
        preAddLabelsAtMs,
        toleranceMs: 0,
      }),
      preAddLabelsAtMs,
    );
  });

  await t.test('non-finite toleranceMs ⇒ degrades to preAddLabelsAtMs without skew', () => {
    const preAddLabelsAtMs = 1_700_000_500_000;
    assert.equal(
      computeCycleStartMs({
        events: null,
        lockLabel: LOCK,
        preAddLabelsAtMs,
        toleranceMs: NaN,
      }),
      preAddLabelsAtMs,
    );
  });

  await t.test('non-finite preAddLabelsAtMs AND no events ⇒ null (defensive)', () => {
    // If both signals are unavailable we have nothing useful to filter on.
    // The caller (dispatchSucceededAlready) treats null as "no filter",
    // matching the original "any historic marker counts" behaviour. This
    // path shouldn't be reachable from main() — `preAddLabelsAtMs` is
    // always Date.now() there — but the helper is defensive.
    assert.equal(
      computeCycleStartMs({
        events: null,
        lockLabel: LOCK,
        preAddLabelsAtMs: NaN,
      }),
      null,
    );
    assert.equal(computeCycleStartMs(), null);
    assert.equal(computeCycleStartMs({}), null);
  });

  await t.test(
    'end-to-end: hasSuccessMarkerAfter with computeCycleStartMs filters prior-cycle marker on propagation lag',
    async () => {
      // Compose the two helpers exactly as main() does, with the events
      // list missing the latest unlabeled (propagation lag). The prior
      // cycle's SUCCESS marker must be filtered out so the new run
      // proceeds to call Cursor.
      const { hasSuccessMarkerAfter } = await import('./review-dispatch.mjs');
      const MARKER = '<!-- review-dispatch:agent -->';
      const successBody = `${MARKER}\n\n🚀 **Cursor Cloud Agent dispatched** (finding)`;

      const preAddLabelsAtMs = 1_700_000_500_000;
      const priorSuccessTs = preAddLabelsAtMs - 60_000; // 1 minute before this run

      // Events list as the API returns it under propagation lag.
      const events = [
        {
          event: 'labeled',
          label: { name: LOCK },
          created_at: baseIso(preAddLabelsAtMs - 120_000),
        },
      ];

      const cycleStartMs = computeCycleStartMs({
        events,
        lockLabel: LOCK,
        preAddLabelsAtMs,
      });
      // Under PR #1357 this would have been `null` → no filter →
      // hasSuccessMarkerAfter returns true → run skips Cursor → bug.
      // Under the fix it's `preAddLabelsAtMs - 1500`, well after the
      // prior cycle's marker timestamp.
      assert.ok(
        Number.isFinite(cycleStartMs) && cycleStartMs > priorSuccessTs,
        `cycleStartMs (${cycleStartMs}) must be a finite value strictly after priorSuccessTs (${priorSuccessTs})`,
      );
      assert.equal(
        hasSuccessMarkerAfter({
          comments: [{ body: successBody, created_at: baseIso(priorSuccessTs) }],
          sinceMs: cycleStartMs,
        }),
        false,
        'prior-cycle SUCCESS marker must NOT be detected as a current-cycle peer success — that would re-block legitimate re-dispatch (#1385)',
      );
    },
  );
});

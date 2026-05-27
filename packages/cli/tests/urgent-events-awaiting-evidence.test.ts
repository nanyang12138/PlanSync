// Fixes #1348 — the CLI's URGENT_EVENTS set drives the 30s red flash above
// the prompt for high-signal events. PR #1223 introduced
// `task_awaiting_evidence` (R-192 gate) and the browser surfaces it as a
// **sticky warning** toast (see packages/api/src/components/notifications.tsx
// — `task_awaiting_evidence` returns `level: 'warning', sticky: true`).
//
// Before this fix the CLI's URGENT_EVENTS set did not include the new event
// type, so the same condition that pops a red sticky warning in the browser
// was silently appended to `/notifs` with no flash on the terminal. This
// test pins the urgency parity between the two surfaces.
//
// Keep this in sync with the sticky-warning set on the browser side.

process.env.PLANSYNC_API_URL = 'http://urgent-events-test.local';
process.env.PLANSYNC_API_KEY = 'test-key';
process.env.PLANSYNC_USER = 'tester';

import { describe, it, expect } from 'vitest';
import { URGENT_EVENTS } from '../src/sse-listener.js';

describe('URGENT_EVENTS — CLI urgency parity with browser sticky warnings (fixes #1348)', () => {
  it('includes task_awaiting_evidence so the prompt flashes red like the browser sticky warning', () => {
    expect(URGENT_EVENTS.has('task_awaiting_evidence')).toBe(true);
  });

  it('keeps the previously-urgent events (regression guard)', () => {
    for (const ev of [
      'drift_detected',
      'execution_stale',
      'plan_activated',
      'review_requested',
      'review_approved',
      'review_rejected',
      'task_assigned',
      'suggestion_created',
    ]) {
      expect(URGENT_EVENTS.has(ev)).toBe(true);
    }
  });

  it('does not promote low-signal events to urgent', () => {
    for (const ev of ['task_started', 'task_completed', 'comment_added', 'plan_draft_updated']) {
      expect(URGENT_EVENTS.has(ev)).toBe(false);
    }
  });
});

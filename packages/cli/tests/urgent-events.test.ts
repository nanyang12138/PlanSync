// Closes #1402 — the R-192 evidence-gate event `task_awaiting_evidence` is a
// sticky warning on the Web surface (packages/api/src/components/notifications.tsx),
// but it was missing from the CLI's `URGENT_EVENTS` whitelist. As a result the
// Ink prompt area above the input line did not flash red for 30 s when the
// gate parked a task — users could miss the fact that their run had been
// blocked pending PR-merge / deliverable-commit signals.
//
// This test pins the CLI urgency whitelist so the two surfaces stay in sync.

import { describe, it, expect } from 'vitest';
import { URGENT_EVENTS } from '../src/urgent-events.js';

describe('URGENT_EVENTS (CLI 30s red flash whitelist)', () => {
  it('includes task_awaiting_evidence so the R-192 gate is surfaced urgently (closes #1402)', () => {
    expect(URGENT_EVENTS.has('task_awaiting_evidence')).toBe(true);
  });

  it('continues to cover the pre-existing urgent events', () => {
    // Regression guard: do not silently drop events that were previously
    // urgent. If a future change intentionally demotes one of these, update
    // both this list and the Web sticky-warning mapping in lockstep.
    const expected = [
      'drift_detected',
      'execution_stale',
      'plan_activated',
      'review_requested',
      'review_approved',
      'review_rejected',
      'task_assigned',
      'suggestion_created',
    ];
    for (const ev of expected) {
      expect(URGENT_EVENTS.has(ev)).toBe(true);
    }
  });

  it('does not mark routine task lifecycle events as urgent', () => {
    // task_started / task_completed / task_unassigned land in the notif log
    // but should not flash the prompt — they are informational on the Web
    // side as well (info-level toast, auto-dismiss).
    expect(URGENT_EVENTS.has('task_started')).toBe(false);
    expect(URGENT_EVENTS.has('task_completed')).toBe(false);
    expect(URGENT_EVENTS.has('task_unassigned')).toBe(false);
  });
});

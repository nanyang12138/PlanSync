// Closes #1231 — PR #1223 added the `task_awaiting_evidence` named SSE event
// (R-192 evidence gate parked the task) but no client surface picked it up.
// The browser-side fix is to register the new event name on the
// EventSource.addEventListener whitelist (see use-realtime.ts /
// notifications.tsx / notification-bell.tsx).
//
// On the CLI side, CliSseListener already forwards every parsed named event
// to its handler, so the only gap was that `describeEvent` returned `null`
// for the new type — which means the notification bar would render nothing.
// This test pins the CLI's describeEvent behaviour for the new event type.

process.env.PLANSYNC_API_URL = 'http://describe-event-test.local';
process.env.PLANSYNC_API_KEY = 'test-key';
process.env.PLANSYNC_USER = 'tester';

import { describe, it, expect } from 'vitest';
import { describeEvent } from '../src/sse-listener.js';

describe('describeEvent — task_awaiting_evidence (R-192, closes #1231)', () => {
  it('renders a one-line summary that includes the task title', () => {
    const line = describeEvent('task_awaiting_evidence', {
      taskId: 't-1',
      title: 'Wire R-192 gate',
      missing: [{ code: 'pr_merged' }, { code: 'deliverable_commit' }],
    });
    expect(line).not.toBeNull();
    expect(line).toContain('Wire R-192 gate');
    expect(line).toMatch(/awaiting evidence/i);
  });

  it('lists the missing signal codes when present', () => {
    const line = describeEvent('task_awaiting_evidence', {
      taskId: 't-2',
      title: 'Land deliverable commit',
      missing: [{ code: 'pr_merged' }],
    });
    expect(line).toContain('pr_merged');
  });

  it('accepts plain string codes as well as { code } objects', () => {
    const line = describeEvent('task_awaiting_evidence', {
      taskId: 't-3',
      title: 'String-codes shape',
      missing: ['pr_merged'],
    });
    expect(line).toContain('pr_merged');
  });

  it('omits the missing-list suffix when payload has no codes', () => {
    const line = describeEvent('task_awaiting_evidence', {
      taskId: 't-4',
      title: 'No missing codes',
      missing: [],
    });
    expect(line).not.toBeNull();
    expect(line).toMatch(/awaiting evidence$/);
  });

  it('falls back to taskId when the payload has no title', () => {
    const line = describeEvent('task_awaiting_evidence', {
      taskId: 'tid-only',
    });
    expect(line).toContain('tid-only');
    expect(line).toMatch(/awaiting evidence/i);
  });
});

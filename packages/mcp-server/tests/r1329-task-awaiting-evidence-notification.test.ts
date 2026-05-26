// Fixes #1329 (PR #1308 review finding 00517b9f69f1) — the MCP-side SSE
// event dispatcher silently dropped `task_awaiting_evidence` because the
// switch in `packages/mcp-server/src/index.ts` had no case for it, so the
// event fell into the `default` branch and was logged at debug level only.
// MCP-connected agents and IDEs (Claude Code, Codex, Cursor, Genie) never
// saw the "awaiting evidence" prompt.
//
// The fix:
//   1. Add a `case 'task_awaiting_evidence'` that pushes a `warning`
//      notification listing the missing signal codes, mirroring the CLI
//      fix from commit 3f74e4d (#1231).
//   2. Extract the message-formatting logic into the exported
//      `formatAwaitingEvidenceMessage` helper so this regression is
//      pinned by a unit test (the surrounding switch lives inside a
//      closure in `main()` and is not externally reachable).
//
// This file pins the formatter contract so any future refactor that drops
// the case or breaks the payload-parsing tripwires here.

import { describe, it, expect } from 'vitest';
import { formatAwaitingEvidenceMessage } from '../src/event-notification.js';

describe('formatAwaitingEvidenceMessage — MCP notification for task_awaiting_evidence (R-192, fixes #1329)', () => {
  it('renders a warning-style summary that includes the task title', () => {
    const line = formatAwaitingEvidenceMessage({
      taskId: 't-1',
      title: 'Wire R-192 gate',
      missing: [{ code: 'pr_merged' }, { code: 'deliverable_evidence' }],
    });
    expect(line).toContain('Wire R-192 gate');
    expect(line).toMatch(/awaiting evidence/i);
    // Owner-action language matters — this is what tells the agent the
    // task is NOT done and they need to escalate to the owner.
    expect(line).toMatch(/owner action required/i);
  });

  it('lists the missing signal codes when present (object shape)', () => {
    const line = formatAwaitingEvidenceMessage({
      taskId: 't-2',
      title: 'Land deliverable evidence',
      missing: [{ code: 'pr_merged' }, { code: 'deliverable_evidence' }],
    });
    expect(line).toContain('pr_merged');
    expect(line).toContain('deliverable_evidence');
  });

  it('accepts plain string codes as well as { code } objects', () => {
    const line = formatAwaitingEvidenceMessage({
      taskId: 't-3',
      title: 'String-codes shape',
      missing: ['pr_merged'],
    });
    expect(line).toContain('pr_merged');
  });

  it('omits the missing-list suffix when payload has no codes', () => {
    const line = formatAwaitingEvidenceMessage({
      taskId: 't-4',
      title: 'Land deliverable',
      missing: [],
    });
    // No " — missing " segment when the array is empty.
    expect(line).not.toMatch(/ — missing /);
    expect(line).toMatch(/awaiting evidence/i);
  });

  it('falls back to taskId when the payload has no title', () => {
    const line = formatAwaitingEvidenceMessage({
      taskId: 'tid-only',
      missing: [],
    });
    expect(line).toContain('tid-only');
    expect(line).toMatch(/awaiting evidence/i);
  });

  it('prefixes with [projectName] when the event came from user-level SSE', () => {
    // The MCP server subscribes to `/api/user-events` which enriches every
    // event with `projectName`. The closure in index.ts uses this to add
    // a `[ProjectName]` prefix so multi-project users can tell where the
    // notification came from. The formatter must respect that contract.
    const line = formatAwaitingEvidenceMessage({
      taskId: 't-5',
      title: 'Cross-project ping',
      projectName: 'PlanSync',
      missing: [{ code: 'pr_merged' }],
    });
    expect(line.startsWith('[PlanSync] ')).toBe(true);
  });

  it('survives a malformed missing payload without throwing', () => {
    // Defensive: webhook publishers occasionally serialise the array as
    // null or as a non-array. We accept any shape and degrade to "no
    // codes" rather than crashing the MCP dispatcher.
    const line = formatAwaitingEvidenceMessage({
      taskId: 't-6',
      title: 'Bad payload',
      missing: null as unknown as never,
    });
    expect(line).toMatch(/awaiting evidence/i);
    expect(line).not.toMatch(/ — missing /);
  });
});
